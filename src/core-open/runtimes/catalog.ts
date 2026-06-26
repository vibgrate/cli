// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
/**
 * Pure accessors over a {@link RuntimeCatalog}. No Node or network imports — this
 * module is the shared "brain" imported by both `@vibgrate/core` (DriftScore) and
 * `@vibgrate/api` (RiskScore / `/v1/reference/runtimes`).
 *
 * The `productForType` / `extractCycle` / `cycleEolStatus` helpers are the
 * canonical versions previously duplicated in `vibgrate-api/src/lib/eol.ts`.
 */
import type { RuntimeCatalog, RuntimeCycle, RuntimeVersion } from './types.js';

/** Map a Vibgrate project type to an endoflife.date product slug. */
export function productForType(type: string): string | null {
  switch (type) {
    case 'node': return 'nodejs';
    case 'python': return 'python';
    case 'dotnet': return 'dotnet';
    case 'java': return 'java';
    case 'php': return 'php';
    case 'ruby': return 'ruby';
    case 'go': return 'go';
    default: return null;
  }
}

/** Extract the endoflife.date "cycle" key for a product from a runtime string. */
export function extractCycle(type: string, runtime: string | undefined | null): string | null {
  if (!runtime) return null;
  switch (type) {
    case 'python':
    case 'php':
    case 'ruby':
    case 'go': {
      // major.minor cycles, e.g. "3.11"
      const m = runtime.match(/(\d+)\.(\d+)/);
      return m ? `${m[1]}.${m[2]}` : null;
    }
    case 'dotnet': {
      // "net8.0" → "8.0"
      const m = runtime.match(/(\d+)\.(\d+)/) ?? runtime.match(/(\d+)/);
      if (!m) return null;
      return m[2] !== undefined ? `${m[1]}.${m[2]}` : `${m[1]}.0`;
    }
    case 'node': {
      // major cycles, e.g. "20"
      const m = runtime.match(/(\d+)/);
      return m ? m[1] : null;
    }
    case 'java': {
      // "1.8" → "8"; "17" → "17"
      const legacy = runtime.match(/1\.(\d+)/);
      if (legacy) return legacy[1];
      const m = runtime.match(/(\d+)/);
      return m ? m[1] : null;
    }
    default:
      return null;
  }
}

/** Minimal cycle shape needed for EOL evaluation (compatible with RuntimeCycle). */
export interface EolCycle {
  cycle: string;
  eol: string | boolean;
}

/**
 * Decide whether `cycle` is EOL given a product's cycle data.
 * Returns true (EOL), false (supported), or null (cycle not found / unknown).
 */
export function cycleEolStatus(
  cycle: string,
  cycles: readonly EolCycle[],
  now: number = Date.now(),
): boolean | null {
  const entry = cycles.find((c) => String(c.cycle) === cycle);
  if (!entry) return null;
  if (typeof entry.eol === 'boolean') return entry.eol;
  const eolMs = Date.parse(entry.eol);
  if (Number.isNaN(eolMs)) return null;
  return eolMs <= now;
}

/** Parse a cycle string ("22", "3.13", "8.0") into a comparable version. */
export function parseCycle(cycle: string): RuntimeVersion | null {
  const m = String(cycle).match(/^(\d+)(?:\.(\d+))?/);
  if (!m) return null;
  return { major: parseInt(m[1]!, 10), minor: m[2] ? parseInt(m[2], 10) : 0 };
}

function rank(v: RuntimeVersion): number {
  return v.major * 1000 + v.minor;
}

/** A cycle is released if it has no release date or one already in the past. */
function isReleased(cycle: RuntimeCycle, now: number): boolean {
  if (typeof cycle.releaseDate !== 'string') return true;
  const ts = Date.parse(cycle.releaseDate);
  return Number.isNaN(ts) ? true : ts <= now;
}

/** A cycle is LTS if `lts` is `true` or an LTS-start date already in the past. */
function isLts(cycle: RuntimeCycle, now: number): boolean {
  if (cycle.lts === true) return true;
  if (typeof cycle.lts === 'string') {
    const ts = Date.parse(cycle.lts);
    return !Number.isNaN(ts) && ts <= now;
  }
  return false;
}

function cyclesFor(catalog: RuntimeCatalog, product: string): RuntimeCycle[] {
  return catalog.products[product]?.cycles ?? [];
}

/** The newest released cycle for a product (max cycle). */
export function latestStable(
  catalog: RuntimeCatalog,
  product: string,
  now: number = Date.now(),
): RuntimeVersion | null {
  let best: RuntimeVersion | null = null;
  for (const cycle of cyclesFor(catalog, product)) {
    if (!isReleased(cycle, now)) continue;
    const v = parseCycle(cycle.cycle);
    if (v && (!best || rank(v) > rank(best))) best = v;
  }
  return best;
}

/** The newest released LTS cycle for a product (Node/Java). */
export function latestLts(
  catalog: RuntimeCatalog,
  product: string,
  now: number = Date.now(),
): RuntimeVersion | null {
  let best: RuntimeVersion | null = null;
  for (const cycle of cyclesFor(catalog, product)) {
    if (!isReleased(cycle, now) || !isLts(cycle, now)) continue;
    const v = parseCycle(cycle.cycle);
    if (v && (!best || rank(v) > rank(best))) best = v;
  }
  return best;
}

/** The ISO EOL date for a specific cycle, when it is a real date. */
export function eolDate(
  catalog: RuntimeCatalog,
  product: string,
  cycle: string,
): string | undefined {
  const entry = cyclesFor(catalog, product).find((c) => String(c.cycle) === cycle);
  return entry && typeof entry.eol === 'string' ? entry.eol : undefined;
}

/** EOL status of a project's own cycle within the catalog (true/false/null). */
export function runtimeEolStatus(
  catalog: RuntimeCatalog,
  type: string,
  runtime: string | undefined | null,
  now: number = Date.now(),
): boolean | null {
  const product = productForType(type);
  if (!product) return null;
  const cycle = extractCycle(type, runtime);
  if (!cycle) return null;
  return cycleEolStatus(cycle, cyclesFor(catalog, product), now);
}

/** Build a catalog from raw endoflife.date payloads keyed by product slug. */
export function buildCatalog(
  rawByProduct: Record<string, unknown>,
  generatedAt: string = new Date().toISOString(),
): RuntimeCatalog {
  const products: Record<string, { product: string; cycles: RuntimeCycle[] }> = {};
  for (const [product, raw] of Object.entries(rawByProduct)) {
    if (!Array.isArray(raw)) continue;
    const cycles: RuntimeCycle[] = [];
    for (const item of raw as Array<Record<string, unknown>>) {
      if (!item || (typeof item.cycle !== 'string' && typeof item.cycle !== 'number')) continue;
      const eol = typeof item.eol === 'string' || typeof item.eol === 'boolean' ? item.eol : false;
      const cycle: RuntimeCycle = { cycle: String(item.cycle), eol };
      if (typeof item.releaseDate === 'string') cycle.releaseDate = item.releaseDate;
      if (typeof item.lts === 'string' || typeof item.lts === 'boolean') cycle.lts = item.lts;
      if (typeof item.latest === 'string') cycle.latestPatch = item.latest;
      cycles.push(cycle);
    }
    products[product] = { product, cycles };
  }
  return { generatedAt, source: 'endoflife.date', products };
}

/** Products the catalog is expected to carry. */
export const RUNTIME_PRODUCTS = ['nodejs', 'python', 'dotnet', 'java', 'php', 'ruby', 'go'] as const;
