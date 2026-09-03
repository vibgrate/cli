/**
 * H4, engine side (docs/VSCODE-HAILE-MODULE-NOW.md §5.6): when the architecture
 * module has classified the map, the context builders prefer the symbols that
 * carry the application's shape — controllers, application services, ports —
 * inside the first tokens of an answer, and leave utilities out unless the
 * ask names them or asks for that role.
 *
 * This is a re-ordering of an already-ranked seed list, never a scorer: the
 * relevance engine (or the mechanical fallback) decides what matches; this
 * decides what a reader with a small budget should see first. It is inert
 * without a classify file bound to the graph, and it never invents a role —
 * abstain / unknown symbols are simply not in the map.
 */
import { resolveGraphPath } from '../artifacts.js';
import { readHaileSidecar } from './sidecar.js';
import { isUsableHaileSymbol } from './format.js';

export interface RoleHint {
  role: string;
  band: string;
}

/** node id → role, for symbols the module was confident about. */
export type RoleMap = Map<string, RoleHint>;

/** Roles that describe what the application does, shown first under a tight budget. */
export const PREFERRED_ROLES: ReadonlySet<string> = new Set(['controller', 'application_service', 'port']);
/** Roles left out of a budgeted answer unless the ask reaches for them. */
export const DEMOTED_ROLES: ReadonlySet<string> = new Set(['utility']);

/**
 * Read the classify file next to the map, bound to `corpusHash`. Returns
 * null when there is none (module absent, privacy mode, stale sidecar) — the
 * callers then leave the ranking exactly as it was.
 */
export function loadRoleMap(root: string, corpusHash: string | undefined): RoleMap | null {
  try {
    const sidecar = readHaileSidecar(resolveGraphPath(root), { corpusHash });
    if (!sidecar) return null;
    const map: RoleMap = new Map();
    for (const symbol of sidecar.symbols) {
      if (!isUsableHaileSymbol(symbol)) continue;
      if (symbol.role.band === 'abstain' || symbol.role.primary === 'unknown') continue;
      map.set(symbol.node_id, { role: symbol.role.primary, band: symbol.role.band });
    }
    return map.size ? map : null;
  } catch {
    return null;
  }
}

/** The ask reaches for utilities when it names one, or asks for helpers/utilities as such. */
function asksForUtilities(question: string): boolean {
  return /\b(util|utils|utility|utilities|helper|helpers|format(?:ter|ting)?|parse(?:r|rs|ing)?|convert(?:er|ers)?|mapper|serializ|transform)\w*/i.test(question);
}

/** Identifier parts of the ask, lowercased, so "chargeCard" and "charge_card" both name `chargeCard`. */
function askIdentifiers(question: string): Set<string> {
  return new Set(
    question
      .split(/[^\p{L}\p{N}_]+/u)
      .filter((t) => t.length >= 3)
      .map((t) => t.toLowerCase()),
  );
}

export interface Seedlike {
  node: { id: string; name: string; qualifiedName: string };
  why: string;
  /** Set by {@link applyRolePreference} for classified seeds — a structured field, never rendered into the context text. */
  role?: string;
}

/** How many positions a preferred-role seed may rise past better-ranked neighbours. */
export const ROLE_LIFT = 2;

/**
 * Bounded re-order of ranked seeds by architectural role. Relevance decided
 * the order; this nudges it for a reader with a small budget:
 *   - a controller / application_service / port rises by at most
 *     {@link ROLE_LIFT} positions, so it opens the answer when it was close to
 *     the top but never leapfrogs a clearly better match (a wholesale
 *     "preferred roles first" put `register` above `login` for "how does
 *     login work");
 *   - a utility is dropped unless the ask names it or asks for helpers;
 *   - everything else keeps its place, and seeds the module did not classify
 *     are untouched relative to each other.
 * The role travels as a structured `role` field on the seed for surfaces that
 * render structure (JSON, the editor); it is deliberately NOT appended to
 * `why`, which is rendered into the model's context — annotating twelve rows
 * measured +5.6 % context tokens on the test pack, the opposite of the point.
 */
export function applyRolePreference<T extends Seedlike>(seeds: T[], roles: RoleMap | null | undefined, question: string): T[] {
  if (!roles || roles.size === 0 || seeds.length === 0) return seeds;
  const named = askIdentifiers(question);
  const wantsUtilities = asksForUtilities(question);
  // Drop first, then number the survivors: a dropped utility must not count
  // as a place a lifted seed has to climb past.
  const kept: Array<{ seed: T; lift: number }> = [];
  for (const seed of seeds) {
    const hint = roles.get(seed.node.id);
    if (!hint) {
      kept.push({ seed, lift: 0 });
      continue;
    }
    const tagged = { ...seed, role: hint.role } as T;
    if (PREFERRED_ROLES.has(hint.role)) {
      kept.push({ seed: tagged, lift: ROLE_LIFT });
    } else if (DEMOTED_ROLES.has(hint.role)) {
      const isNamed =
        named.has(seed.node.name.toLowerCase()) ||
        [...named].some((t) => seed.node.qualifiedName.toLowerCase().endsWith(`.${t}`));
      if (wantsUtilities || isNamed) kept.push({ seed: tagged, lift: 0 });
      // otherwise dropped: a utility the ask did not reach for is budget spent on plumbing
    } else {
      kept.push({ seed: tagged, lift: 0 });
    }
  }
  const keyed = kept.map((k, index) => ({ seed: k.seed, key: index - k.lift, index }));
  // A seed that lands on a neighbour's key keeps rank order (stable).
  keyed.sort((a, b) => a.key - b.key || a.index - b.index);
  return keyed.map((k) => k.seed);
}
