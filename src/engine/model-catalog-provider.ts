/**
 * Model-catalog seam for context compression.
 *
 * Context windows, output caps, thinking/cache billing and list prices are
 * standing vendor fact: they change when a vendor changes them, not when we cut
 * a release. Holding them as a table in this package meant a CLI release per
 * price change, and shipped the whole curated set in every published tarball.
 * They now live in one place — `data/models/capabilities.json` in the relevance
 * package — compiled into the optional module and reached only through here.
 *
 * WHAT STAYS IN THIS PACKAGE is the logic, not the data: pattern inference for
 * ids nobody has catalogued, the conservative default window, the blended
 * price. That division is deliberate, because compression is NOT optional and
 * this module is. With no module installed every id falls through to that
 * logic and compression still runs — the catalog makes it sharper, it is not a
 * dependency.
 *
 * THE SAFE DIRECTION. A context limit that reads too LOW makes compression work
 * harder than it needs to; one that reads too HIGH overflows the model and the
 * request fails. So every doubtful row is dropped rather than clamped, and the
 * caller's own conservative default takes over. Nothing here ever raises a
 * limit it cannot justify.
 *
 * Loading mirrors the relevance and surface seams exactly (same module, same
 * kill switch, same override), and every failure path degrades to `null`.
 *
 * Priming is explicit because the consumers are synchronous: `modelInfo()` and
 * `priceFor()` are called from deep inside the compression pipeline and the
 * proxy's per-request cost accounting, where an await would mean rewriting both
 * call graphs. `primeModelCatalog()` runs once during CLI startup; every later
 * read is a synchronous map lookup.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Per-1M-token list prices. `null` where the vendor publishes no such rate. */
export interface CatalogPrice {
  input: number;
  output: number;
  cacheRead: number | null;
  cacheWrite: number | null;
}

export interface CatalogModel {
  id: string;
  family: string;
  contextLimit: number;
  maxOutput: number | null;
  billsThinking: boolean;
  supportsCacheControl: boolean;
  aliases: string[];
  price: CatalogPrice | null;
}

export interface ModelCatalogSnapshot {
  /** Version stamp of the compiled catalog. */
  version: string;
  models: CatalogModel[];
}

// ── sanitization bounds ────────────────────────────────────────────────────
// Generous enough that no real vendor row is refused, tight enough that a
// corrupt or hostile value cannot talk the caller into an unsafe budget.
const MAX_CONTEXT = 100_000_000;
const MAX_RATE_PER_1M = 10_000;
const MAX_ALIASES = 24;
const MAX_MODELS = 5_000;
const MAX_ID = 128;

/** Control characters are stripped: an id reaches logs and error text. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

function cleanId(value: unknown, cap = MAX_ID): string {
  if (typeof value !== 'string') return '';
  return value.replace(CONTROL_CHARS, '').trim().toLowerCase().slice(0, cap);
}

/** A positive, finite integer inside `max`, or `null`. Never clamps. */
function bounded(value: unknown, max: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value <= 0 || value > max) return null;
  return Math.floor(value);
}

/** A non-negative finite rate inside the cap, or `null`. Never clamps. */
function rate(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value < 0 || value > MAX_RATE_PER_1M) return null;
  return value;
}

function sanitizePrice(raw: unknown): CatalogPrice | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  const input = rate(p.input);
  const output = rate(p.output);
  // A price is only usable with both sides. Half a price would quote a saving
  // from a real input rate and an invented output rate.
  if (input === null || output === null) return null;
  return { input, output, cacheRead: rate(p.cacheRead), cacheWrite: rate(p.cacheWrite) };
}

/**
 * Normalise whatever the module returned. Every row must earn its place: an id,
 * and a context limit inside the bounds. A row that fails is dropped, not
 * repaired — the caller's default is a better answer than a guessed window.
 */
export function sanitizeModelTable(raw: unknown): ModelCatalogSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const table = raw as Record<string, unknown>;
  if (!Array.isArray(table.models)) return null;

  const models: CatalogModel[] = [];
  const seen = new Set<string>();
  for (const row of table.models.slice(0, MAX_MODELS)) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const id = cleanId(r.id);
    const contextLimit = bounded(r.contextLimit, MAX_CONTEXT);
    if (!id || seen.has(id) || contextLimit === null) continue;
    seen.add(id);
    models.push({
      id,
      family: cleanId(r.family, 32),
      contextLimit,
      maxOutput: bounded(r.maxOutput, MAX_CONTEXT),
      billsThinking: r.billsThinking === true,
      supportsCacheControl: r.supportsCacheControl === true,
      aliases: Array.isArray(r.aliases)
        ? r.aliases.map((a) => cleanId(a)).filter((a) => a && a !== id).slice(0, MAX_ALIASES)
        : [],
      price: sanitizePrice(r.price),
    });
  }
  if (models.length === 0) return null;
  return { version: cleanId(table.version, 32), models };
}

// ── loading ────────────────────────────────────────────────────────────────

function modulePath(env: NodeJS.ProcessEnv): string | null {
  const override = env.VIBGRATE_RELEVANCE_PATH?.trim();
  if (override) {
    try {
      return fs.statSync(override).isDirectory() ? path.join(override, 'index.js') : override;
    } catch {
      return null;
    }
  }
  const base = env.XDG_CACHE_HOME?.trim() || path.join(os.homedir(), '.cache');
  return path.join(base, 'vibgrate', 'modules', 'relevance', 'index.js');
}

let cache: ModelCatalogSnapshot | null | undefined;

/**
 * Load the catalog once. Safe to call repeatedly and from anywhere; the first
 * call wins and later ones are free. Never throws: a module that is missing,
 * broken, or older than this catalog is simply no catalog.
 */
export async function primeModelCatalog(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (cache !== undefined) return;
  cache = null;
  if (env.VIBGRATE_NO_KERNEL === '1') return;
  const file = modulePath(env);
  if (!file) return;
  try {
    if (!fs.existsSync(file)) return;
    const mod = (await import(pathToFileURL(file).href)) as {
      createModelCatalog?: () => { table?: () => unknown } | null;
    };
    const catalog = mod.createModelCatalog?.();
    if (!catalog || typeof catalog.table !== 'function') return;
    cache = sanitizeModelTable(catalog.table());
  } catch {
    cache = null; // a broken module is treated as no module at all
  }
}

/** The primed catalog, or `null`. Synchronous by design — see the file header. */
export function modelCatalogSnapshot(): ModelCatalogSnapshot | null {
  return cache ?? null;
}

/** Reset the memoized catalog (tests only). */
export function resetModelCatalog(): void {
  cache = undefined;
}

/** Seed the catalog directly (tests only). */
export function setModelCatalogForTests(snapshot: ModelCatalogSnapshot | null): void {
  cache = snapshot;
}
