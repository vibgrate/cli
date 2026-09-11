/**
 * USD-per-1M-token pricing. First-party list prices from the relevance module
 * (see `engine/model-catalog-provider.ts`) + pattern inference for unseen ids +
 * user overrides from `VG_MODEL_PRICES` (JSON) and `models.json`, with a
 * blended fallback so a savings figure always exists. Cache-read / cache-write
 * rates default to the provider's standard multiplier when a row omits them.
 */

import { env as knobEnv } from './config.js';
import { canonicalModelId, loadModelsConfig, modelInfo } from './models.js';
import { modelCatalogSnapshot } from '../engine/model-catalog-provider.js';
import { modelIdCandidates } from './tokenizers.js';

export interface Price {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** Used when nothing else prices a model (mid-tier frontier rate). */
export const BLENDED_PRICE: Readonly<Price> = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };

/**
 * List prices come from the relevance module, never from a table here.
 *
 * They used to be a ~93-row map in this file, carrying a "verified 2026-06"
 * comment that nothing enforced — a price a vendor changed the next week was
 * still quoted to users until the next CLI release. They now live in
 * `data/models/capabilities.json` in the relevance package, compiled into the
 * module and refreshed weekly.
 *
 * `inferPrice`, `BLENDED_PRICE` and the user overrides below did NOT move: they
 * are what quotes a saving when no module is installed or no row covers an id,
 * and compression must keep working in both cases.
 */
function priceTable(): Map<string, Price> {
  const snapshot = modelCatalogSnapshot();
  if (tableCache && tableCache.source === snapshot) return tableCache.value;
  const value = new Map<string, Price>();
  for (const m of snapshot?.models ?? []) {
    if (!m.price) continue;
    const p: Price = { input: m.price.input, output: m.price.output };
    // `null` means the vendor publishes no such rate; the resolver below then
    // applies the provider's standard multiplier rather than quoting zero.
    if (m.price.cacheRead !== null) p.cacheRead = m.price.cacheRead;
    if (m.price.cacheWrite !== null) p.cacheWrite = m.price.cacheWrite;
    value.set(m.id, p);
  }
  tableCache = { source: snapshot, value };
  return value;
}

let tableCache: {
  source: ReturnType<typeof modelCatalogSnapshot>;
  value: Map<string, Price>;
} | null = null;

/** Reset the derived price table (tests only; the seam has its own reset). */
export function resetPriceTableForTests(): void {
  tableCache = null;
}

const P = (input: number, output: number, cacheRead?: number, cacheWrite?: number): Price => {
  const p: Price = { input, output };
  if (cacheRead !== undefined) p.cacheRead = cacheRead;
  if (cacheWrite !== undefined) p.cacheWrite = cacheWrite;
  return p;
};

/** A locally-run model costs nothing per token. */
const FREE: Readonly<Price> = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export function inferPrice(id: string): Price | null {
  const s = id.toLowerCase();
  if (/^ollama\//.test(s) || /:latest$|:\d+b$/.test(s) || /local/.test(s)) return { ...FREE };
  if (/fable|mythos/.test(s)) return P(10, 50, 0.25, 12.5);
  if (/opus/.test(s)) return P(5, 25, 0.5, 6.25);
  if (/sonnet/.test(s)) return P(3, 15, 0.3, 3.75);
  if (/haiku/.test(s)) return P(1, 5, 0.1, 1.25);
  if (/claude/.test(s)) return P(3, 15, 0.3, 3.75);
  if (/^gpt-[6-9]/.test(s)) return P(10, 50, 1);
  if (/^gpt-5\.6/.test(s)) return P(2, 12, 0.2);
  if (/^gpt-5\.5/.test(s)) return P(5, 30, 0.5);
  if (/^gpt-5\.[34]/.test(s)) return P(2.5, 15, 0.25);
  if (/^gpt-5/.test(s)) return P(1.25, 10, 0.125);
  if (/^gpt-4\.1/.test(s)) return P(2, 8, 0.5);
  if (/^gpt-4o-mini/.test(s)) return P(0.15, 0.6, 0.075);
  if (/^gpt-4o/.test(s)) return P(2.5, 10, 1.25);
  if (/^o[1-9]/.test(s)) return P(2, 8, 0.5);
  if (/^gpt-4/.test(s)) return P(10, 30, 5);
  if (/^gpt-3/.test(s)) return P(0.5, 1.5, 0.25);
  if (/gemini-3.*flash-lite/.test(s)) return P(0.3, 2.5, 0.03);
  if (/gemini-3.*flash/.test(s)) return P(0.75, 3.75, 0.075);
  if (/gemini-3.*pro/.test(s)) return P(2, 12, 0.2);
  if (/gemini.*flash/.test(s)) return P(0.3, 2.5, 0.075);
  if (/gemini|gemma/.test(s)) return P(1.25, 10, 0.31);
  if (/llama/.test(s)) return P(0.6, 0.6);
  if (/mistral|mixtral|codestral|ministral/.test(s)) return P(0.4, 2);
  if (/deepseek/.test(s)) return P(0.27, 1.1, 0.07);
  if (/grok-4\.(?:[5-9]|\d{2,})/.test(s)) return P(2, 6, 0.5);
  if (/grok-4\.[2-4]/.test(s)) return P(1.25, 2.5, 0.2);
  if (/grok/.test(s)) return P(3, 15, 0.75);
  if (/qwen|qwq/.test(s)) return P(0.2, 0.6);
  if (/kimi|moonshot/.test(s)) return P(0.6, 2.5, 0.15);
  return null;
}

function fillCacheRates(price: Price, family: string): Price {
  const out: Price = { ...price };
  const anthropic = family === 'anthropic';
  if (out.cacheRead === undefined) out.cacheRead = round6(out.input * (anthropic ? 0.1 : 0.5));
  if (out.cacheWrite === undefined) out.cacheWrite = round6(out.input * (anthropic ? 1.25 : 1));
  return out;
}

function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

function parseOverride(v: unknown): Partial<Price> | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const num = (keys: string[]): number | undefined => {
    for (const k of keys) {
      const x = o[k];
      if (typeof x === 'number' && Number.isFinite(x) && x >= 0) return x;
      if (typeof x === 'string' && x.trim() && Number.isFinite(Number(x)) && Number(x) >= 0) return Number(x);
    }
    return undefined;
  };
  const p: Partial<Price> = {};
  const i = num(['input', 'input_per_1m', 'inputPer1M', 'prompt']);
  const out = num(['output', 'output_per_1m', 'outputPer1M', 'completion']);
  const cr = num(['cacheRead', 'cache_read', 'cached_input_per_1m', 'cached_input']);
  const cw = num(['cacheWrite', 'cache_write', 'cache_creation']);
  if (i !== undefined) p.input = i;
  if (out !== undefined) p.output = out;
  if (cr !== undefined) p.cacheRead = cr;
  if (cw !== undefined) p.cacheWrite = cw;
  return Object.keys(p).length ? p : null;
}

/**
 * `VG_MODEL_PRICES` > models.json > table (canonical id, then unwrapped
 * candidates and longest-prefix) > pattern inference > blended fallback.
 * Always returns all four rates.
 */
export function priceFor(model: string, env: NodeJS.ProcessEnv = process.env): Price {
  const raw = (model ?? '').trim().toLowerCase();
  const canonical = canonicalModelId(raw, env);
  const info = modelInfo(raw, env);
  const candidates = [raw, canonical, ...modelIdCandidates(canonical)];

  let base: Price | null = null;
  for (const c of candidates) {
    const hit = priceTable().get(c);
    if (hit) {
      base = { ...hit };
      break;
    }
  }
  if (!base) {
    for (const c of candidates) {
      let best: string | undefined;
      const table = priceTable();
      for (const id of table.keys()) {
        if (!c.startsWith(id)) continue;
        const rest = c.slice(id.length);
        if (rest && !['-', '/', ':', '@', '_'].includes(rest[0])) continue;
        if (!best || id.length > best.length) best = id;
      }
      if (best) {
        base = { ...(table.get(best) as Price) };
        break;
      }
    }
  }
  if (!base) base = inferPrice(canonical || raw) ?? inferPrice(raw);
  if (!base && info.family === 'ollama') base = { ...FREE };
  if (!base) base = { ...BLENDED_PRICE };

  // models.json overrides
  const config = loadModelsConfig(env);
  for (const key of [canonical, raw]) {
    const entry = config[key];
    if (entry?.price) base = applyOverride(base, stripUndefined(entry.price));
  }
  // env overrides (highest precedence)
  const overrides = knobEnv.json<Record<string, unknown>>('VG_MODEL_PRICES', {}, env);
  if (overrides && typeof overrides === 'object') {
    for (const [k, v] of Object.entries(overrides)) {
      const key = k.trim().toLowerCase();
      if (key !== raw && key !== canonical) continue;
      const o = parseOverride(v);
      if (o) base = applyOverride(base, o);
    }
  }
  return fillCacheRates(base, info.family);
}

/** An override that re-prices `input` invalidates inherited cache rates (they are derived from it unless given). */
function applyOverride(base: Price, o: Partial<Price>): Price {
  const out: Price = { ...base, ...o };
  if (o.input !== undefined) {
    if (o.cacheRead === undefined) delete out.cacheRead;
    if (o.cacheWrite === undefined) delete out.cacheWrite;
  }
  return out;
}

function stripUndefined(p: Partial<Price>): Partial<Price> {
  const out: Partial<Price> = {};
  if (p.input !== undefined) out.input = p.input;
  if (p.output !== undefined) out.output = p.output;
  if (p.cacheRead !== undefined) out.cacheRead = p.cacheRead;
  if (p.cacheWrite !== undefined) out.cacheWrite = p.cacheWrite;
  return out;
}

/** USD for a usage record (per-1M rates), rounded to 6 dp. Negative/NaN counts count as 0. */
export function costUsd(
  model: string,
  usage: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number },
  env: NodeJS.ProcessEnv = process.env,
): number {
  const price = priceFor(model, env);
  const n = (x: number | undefined): number => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : 0);
  const total =
    (n(usage.input) * price.input + n(usage.output) * price.output + n(usage.cacheRead) * (price.cacheRead ?? price.input) + n(usage.cacheWrite) * (price.cacheWrite ?? price.input)) /
    1_000_000;
  return round6(total);
}

/** Dollar value of `tokensSaved` input tokens for a model (the savings ledger's unit). */
export function savingsUsd(model: string, tokensSaved: number, env: NodeJS.ProcessEnv = process.env): number {
  return costUsd(model, { input: tokensSaved }, env);
}
