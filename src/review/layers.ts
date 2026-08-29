/**
 * Layer-skip detection — Review's own rule, on top of the engine's.
 *
 * `evaluateLayerBoundary` (core-open) enforces *direction*: an upward
 * dependency, or `domain → data-access`. It deliberately permits any downward
 * dependency, because for a drift scan "routing depends on data-access" is a
 * shape, not a violation.
 *
 * Review asks a stricter question — did this change move the system toward its
 * *declared* architecture? — and for a declared layered stack, skipping a tier
 * is exactly the archetypal bypass: the new handler calls persistence directly.
 * So Review adds a skip rule, and only when a target pattern was declared:
 * without one there is no stated intent to regress against, and flagging a skip
 * would be promoting the repo's majority to correctness.
 */

import type { ArchitectureLayer } from '../core-open/types.js';

/**
 * Mirrors `LAYERED_STACK` in `core-open/scanners/architecture/graph-refine.ts`,
 * which is not exported. Kept in the same order on purpose — if the engine's
 * stack changes, this must change with it.
 */
export const LAYERED_STACK: readonly ArchitectureLayer[] = [
  'presentation',
  'routing',
  'middleware',
  'services',
  'domain',
  'data-access',
  'infrastructure',
];

const RANK = new Map<ArchitectureLayer, number>(LAYERED_STACK.map((l, i) => [l, i]));

/** Profiles with an ordered tier stack. */
const SKIP_PROFILES = new Set(['layered', 'mvc', 'mvvm']);

/** Clean/hexagonal/onion — dependencies point inward, toward the domain. */
const CLEAN_PROFILES = new Set(['clean', 'hexagonal', 'onion']);

/** The outermost ring: what a user or a request touches first. */
const OUTER_LAYERS = new Set<ArchitectureLayer>(['presentation', 'routing', 'middleware']);

/** The other outermost ring: what talks to the world on the way out. */
const PERSISTENCE_LAYERS = new Set<ArchitectureLayer>(['data-access', 'infrastructure']);

export interface SkipVerdict {
  skipped: boolean;
  /** The tier(s) the dependency jumped over. */
  bypassed: ArchitectureLayer[];
  rule: string;
}

const NO_SKIP: SkipVerdict = { skipped: false, bypassed: [], rule: '' };

/**
 * Does `from → to` skip a tier in the declared stack?
 *
 * `domain` is the dependency sink on this stack (the engine treats it that way
 * too), so a hop that only jumps over `domain` is not a skip — nothing was
 * bypassed that the dependency was supposed to pass through.
 */
export function evaluateLayerSkip(
  profile: string,
  from: ArchitectureLayer,
  to: ArchitectureLayer,
): SkipVerdict {
  // Clean/hexagonal/onion have no tier *ranking* to skip — dependencies point
  // inward — but they do have the rule that makes them what they are: the two
  // outer rings must not touch each other. A controller that news up a
  // repository has bypassed the application layer entirely, which is the
  // canonical violation of the style and the reason it is adopted.
  //
  // The engine's own clean rule only covers `domain → data-access`, so without
  // this a Clean Architecture repository gets no boundary finding at all for
  // the violation its architecture exists to prevent. Verified on a real
  // Clean Architecture repository, where the controller→Infrastructure edge
  // previously went unreported.
  if (CLEAN_PROFILES.has(profile)) {
    if (OUTER_LAYERS.has(from) && PERSISTENCE_LAYERS.has(to)) {
      return {
        skipped: true,
        bypassed: ['services'],
        rule: `${profile}:outer-ring:${from}→${to}`,
      };
    }
    return NO_SKIP;
  }

  if (!SKIP_PROFILES.has(profile)) return NO_SKIP;
  const a = RANK.get(from);
  const b = RANK.get(to);
  if (a === undefined || b === undefined) return NO_SKIP;
  if (b <= a + 1) return NO_SKIP; // same tier, or the next one down — not a skip
  const bypassed = LAYERED_STACK.slice(a + 1, b).filter((l) => l !== 'domain');
  if (bypassed.length === 0) return NO_SKIP;
  return { skipped: true, bypassed, rule: `${profile}:skip:${from}→${to}` };
}
