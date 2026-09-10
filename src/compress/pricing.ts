/**
 * USD-per-1M-token pricing. Static table (first-party list prices, verified
 * 2026-06) + pattern inference for unseen ids + user overrides from
 * `VG_MODEL_PRICES` (JSON) and `models.json`, with a blended fallback so a
 * savings figure always exists. Cache-read / cache-write rates default to the
 * provider's standard multiplier when a row omits them.
 */

import { env as knobEnv } from './config.js';
import { canonicalModelId, loadModelsConfig, modelInfo } from './models.js';
import { modelIdCandidates } from './tokenizers.js';

export interface Price {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** Used when nothing else prices a model (mid-tier frontier rate). */
export const BLENDED_PRICE: Readonly<Price> = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };

const P = (input: number, output: number, cacheRead?: number, cacheWrite?: number): Price => {
  const p: Price = { input, output };
  if (cacheRead !== undefined) p.cacheRead = cacheRead;
  if (cacheWrite !== undefined) p.cacheWrite = cacheWrite;
  return p;
};

const TABLE: Readonly<Record<string, Price>> = {
  // Anthropic
  'claude-fable-5-1': P(10, 50, 0.25, 12.5),
  'claude-mythos-5-1': P(10, 50, 0.25, 12.5),
  'claude-fable-5': P(10, 50, 1, 12.5),
  'claude-mythos-5': P(10, 50, 1, 12.5),
  'claude-opus-5': P(5, 25, 0.5, 6.25),
  'claude-opus-4-8': P(5, 25, 0.5, 6.25),
  'claude-opus-4-7': P(5, 25, 0.5, 6.25),
  'claude-opus-4-6': P(5, 25, 0.5, 6.25),
  'claude-sonnet-5': P(2, 10, 0.2, 2.5),
  'claude-sonnet-4-6': P(3, 15, 0.3, 3.75),
  'claude-haiku-4-5': P(1, 5, 0.1, 1.25),
  'claude-opus-4-5': P(5, 25, 0.5, 6.25),
  'claude-opus-4-1': P(15, 75, 1.5, 18.75),
  'claude-sonnet-4-5': P(3, 15, 0.3, 3.75),
  'claude-sonnet-4-0': P(3, 15, 0.3, 3.75),
  'claude-opus-4-0': P(15, 75, 1.5, 18.75),
  'claude-3-7-sonnet-20250219': P(3, 15, 0.3, 3.75),
  'claude-3-5-sonnet-20241022': P(3, 15, 0.3, 3.75),
  'claude-3-5-haiku-20241022': P(0.8, 4, 0.08, 1),
  'claude-3-opus-20240229': P(15, 75, 1.5, 18.75),
  'claude-3-haiku-20240307': P(0.25, 1.25, 0.03, 0.3),
  // OpenAI
  // OpenAI (Sep 2026 list; cached input = 10% of input)
  'gpt-6-astra': P(10, 50, 1),
  'gpt-5.6-sol': P(4, 20, 0.4),
  'gpt-5.6-terra': P(2, 12, 0.2),
  'gpt-5.6-luna': P(0.2, 1.2, 0.02),
  'gpt-5.5': P(5, 30, 0.5),
  'gpt-5.4': P(2.5, 15, 0.25),
  'gpt-5.4-mini': P(0.75, 4.5, 0.075),
  'gpt-5.4-nano': P(0.2, 1.25, 0.02),
  'gpt-5.3-codex': P(1.75, 14, 0.175),
  'gpt-5': P(1.25, 10, 0.125),
  'gpt-5-mini': P(0.25, 2, 0.025),
  'gpt-5-nano': P(0.05, 0.4, 0.005),
  'gpt-4.1': P(2, 8, 0.5),
  'gpt-4.1-mini': P(0.4, 1.6, 0.1),
  'gpt-4.1-nano': P(0.1, 0.4, 0.025),
  'gpt-4o': P(2.5, 10, 1.25),
  'gpt-4o-mini': P(0.15, 0.6, 0.075),
  o1: P(15, 60, 7.5),
  'o1-mini': P(1.1, 4.4, 0.55),
  o3: P(2, 8, 0.5),
  'o3-mini': P(1.1, 4.4, 0.55),
  'o4-mini': P(1.1, 4.4, 0.275),
  'gpt-4-turbo': P(10, 30, 5),
  'gpt-4-32k': P(60, 120),
  'gpt-4': P(30, 60),
  'gpt-3.5-turbo': P(0.5, 1.5, 0.25),
  // Google (Gemini 3.6–3.8 Flash: introductory rate through 2026-12-31, then 1.5 / 7.5 / 0.15)
  'gemini-3.8-flash': P(0.75, 3.75, 0.075),
  'gemini-3.7-flash': P(0.75, 3.75, 0.075),
  'gemini-3.6-flash': P(0.75, 3.75, 0.075),
  'gemini-3.5-flash': P(1.5, 9, 0.15),
  'gemini-3.5-flash-lite': P(0.3, 2.5, 0.03),
  'gemini-3.1-flash-lite': P(0.3, 2.5, 0.03),
  'gemini-3.1-pro-preview': P(2, 12, 0.2),
  'gemini-omni-1.1-flash': P(1.5, 9, 0.15),
  'gemini-2.5-pro': P(1.25, 10, 0.31),
  'gemini-2.5-flash': P(0.3, 2.5, 0.075),
  'gemini-2.5-flash-lite': P(0.1, 0.4, 0.025),
  'gemini-2.0-flash': P(0.1, 0.4, 0.025),
  'gemini-1.5-pro': P(1.25, 5, 0.3125),
  'gemini-1.5-flash': P(0.075, 0.3, 0.01875),
  // Meta (typical hosted rates)
  'llama-4-maverick': P(0.2, 0.6),
  'llama-4-scout': P(0.15, 0.5),
  'llama-3.3-70b': P(0.6, 0.6),
  'llama-3.1-405b': P(3, 3),
  'llama-3.1-70b': P(0.6, 0.6),
  'llama-3.1-8b': P(0.1, 0.1),
  // Mistral
  'mistral-large': P(2, 6),
  'mistral-medium': P(0.4, 2),
  'mistral-small': P(0.1, 0.3),
  codestral: P(0.3, 0.9),
  'ministral-8b': P(0.1, 0.1),
  'mixtral-8x7b': P(0.7, 0.7),
  'mistral-7b': P(0.25, 0.25),
  // DeepSeek
  'deepseek-v4-flash': P(0.14, 0.28, 0.0028),
  'deepseek-v4-pro': P(0.435, 0.87, 0.003625),
  'deepseek-chat': P(0.27, 1.1, 0.07),
  'deepseek-reasoner': P(0.55, 2.19, 0.14),
  'deepseek-coder': P(0.14, 0.28),
  // xAI (base tier, prompts under 200k tokens)
  'grok-4.6': P(2, 6, 0.5),
  'grok-4.5': P(2, 6, 0.3),
  'grok-4.3': P(1.25, 2.5, 0.2),
  'grok-build-0.1': P(1, 2, 0.2),
  'grok-4': P(3, 15, 0.75),
  'grok-3': P(3, 15, 0.75),
  'grok-3-mini': P(0.3, 0.5, 0.075),
  'grok-code-fast-1': P(0.2, 1.5, 0.02),
  // Qwen / Moonshot (hosted)
  'qwen3-235b': P(0.2, 0.6),
  'qwen2.5-72b': P(0.4, 1.2),
  'qwen2.5-coder': P(0.2, 0.6),
  'qwen2.5-7b': P(0.05, 0.1),
  'qwq-32b': P(0.15, 0.4),
  'kimi-k2': P(0.6, 2.5, 0.15),
};

const FREE: Readonly<Price> = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** Pattern-based pricing for ids the table does not know (null = no guess). */
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
    const hit = TABLE[c];
    if (hit) {
      base = { ...hit };
      break;
    }
  }
  if (!base) {
    for (const c of candidates) {
      let best: string | undefined;
      for (const id of Object.keys(TABLE)) {
        if (!c.startsWith(id)) continue;
        const rest = c.slice(id.length);
        if (rest && !['-', '/', ':', '@', '_'].includes(rest[0])) continue;
        if (!best || id.length > best.length) best = id;
      }
      if (best) {
        base = { ...TABLE[best] };
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
