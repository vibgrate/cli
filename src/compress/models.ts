/**
 * Model registry: context limits, output caps, family, aliases and the
 * thinking-billing flag. The catalog comes from the relevance module (see
 * `engine/model-catalog-provider.ts`); this file adds pattern inference for ids
 * nobody has catalogued (`*-1m`, `gpt-4.1-mini`, dated snapshots, gateway
 * prefixes) and user overrides from `VG_MODEL_LIMITS`, `VG_MODEL_ALIAS_MAP`,
 * `VG_1M_MODEL` and the `models.json` file at `modelsConfigPath()`.
 *
 * Unknown models resolve to a conservative 128k window (never throws).
 */

import * as fs from 'node:fs';
import { env as knobEnv } from './config.js';
import { modelsConfigPath } from './paths.js';
import { modelIdCandidates } from './tokenizers.js';
import { modelCatalogSnapshot } from '../engine/model-catalog-provider.js';

export interface ModelInfo {
  id: string;
  family: string;
  contextLimit: number;
  maxOutput?: number;
  aliases?: string[];
  billsThinking?: boolean;
  supportsCacheControl?: boolean;
}

export const DEFAULT_CONTEXT_LIMIT = 128_000;
export const ONE_MILLION = 1_000_000;

/** Thousands, for the window sizes the inference below reasons in. */
const K = 1000;

/**
 * The catalog is reached through the module seam, never held here.
 *
 * Context windows, output caps and billing flags used to be a ~110-row table in
 * this file. That meant a CLI release every time a vendor shipped a model, and
 * it put the whole curated set in every published tarball. It now lives in
 * `data/models/capabilities.json` in the relevance package, compiled into the
 * module and refreshed weekly.
 *
 * What did NOT move is everything below: the alias and gateway unwrapping, the
 * pattern inference, `DEFAULT_CONTEXT_LIMIT`, the `models.json` overrides. Those
 * are logic, and they are what keeps compression working when no module is
 * installed — every id then falls through to inference and the conservative
 * default, which is the safe direction to be wrong in.
 */
function catalogIndex(): { byId: Map<string, ModelInfo>; aliases: Map<string, string> } {
  const snapshot = modelCatalogSnapshot();
  // Rebuilt only when the snapshot identity changes — once per process in
  // practice, and `null` (no module) is itself a stable identity.
  if (indexCache && indexCache.source === snapshot) return indexCache.value;
  const byId = new Map<string, ModelInfo>();
  const aliases = new Map<string, string>();
  for (const m of snapshot?.models ?? []) {
    const info: ModelInfo = { id: m.id, family: m.family, contextLimit: m.contextLimit };
    if (m.maxOutput !== null) info.maxOutput = m.maxOutput;
    if (m.aliases.length) info.aliases = [...m.aliases];
    if (m.billsThinking) info.billsThinking = true;
    if (m.supportsCacheControl) info.supportsCacheControl = true;
    byId.set(m.id, info);
    for (const a of m.aliases) aliases.set(a, m.id);
  }
  const value = { byId, aliases };
  indexCache = { source: snapshot, value };
  return value;
}

let indexCache: {
  source: ReturnType<typeof modelCatalogSnapshot>;
  value: { byId: Map<string, ModelInfo>; aliases: Map<string, string> };
} | null = null;

/** Reset the derived index (tests only; the seam has its own reset). */
export function resetModelIndexForTests(): void {
  indexCache = null;
}


/** Every built-in model (sorted by id). */
export function knownModels(): ModelInfo[] {
  return [...catalogIndex().byId.values()]
    .map((m) => ({ ...m, aliases: m.aliases ? [...m.aliases] : undefined }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// ---------------------------------------------------------------------------
// models.json (user overrides)
// ---------------------------------------------------------------------------

export interface ModelsConfigEntry {
  contextLimit?: number;
  maxOutput?: number;
  family?: string;
  aliases?: string[];
  billsThinking?: boolean;
  supportsCacheControl?: boolean;
  price?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
}

export type ModelsConfig = Record<string, ModelsConfigEntry>;

let configCache: { file: string; mtimeMs: number; size: number; value: ModelsConfig } | null = null;

/**
 * Read `models.json` (`{ "<model id>": { contextLimit, maxOutput, family, aliases,
 * billsThinking, price } }`, optionally wrapped in `{ "models": {…} }`). Missing
 * or malformed → `{}`. Cached by (path, mtime, size).
 */
export function loadModelsConfig(env: NodeJS.ProcessEnv = process.env): ModelsConfig {
  const file = modelsConfigPath(env);
  try {
    const st = fs.statSync(file);
    if (configCache && configCache.file === file && configCache.mtimeMs === st.mtimeMs && configCache.size === st.size) return configCache.value;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    let obj: Record<string, unknown> = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    if (obj.models && typeof obj.models === 'object' && !Array.isArray(obj.models)) obj = obj.models as Record<string, unknown>;
    const out: ModelsConfig = {};
    for (const [id, v] of Object.entries(obj)) {
      if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
      const e = v as Record<string, unknown>;
      const entry: ModelsConfigEntry = {};
      const ctx = numberField(e, ['contextLimit', 'context_limit', 'context_window', 'contextWindow', 'max_input_tokens']);
      if (ctx !== undefined) entry.contextLimit = ctx;
      const mo = numberField(e, ['maxOutput', 'max_output', 'max_output_tokens', 'maxOutputTokens']);
      if (mo !== undefined) entry.maxOutput = mo;
      if (typeof e.family === 'string') entry.family = e.family;
      if (typeof e.provider === 'string' && !entry.family) entry.family = e.provider;
      if (Array.isArray(e.aliases)) entry.aliases = e.aliases.filter((a): a is string => typeof a === 'string');
      if (typeof e.billsThinking === 'boolean') entry.billsThinking = e.billsThinking;
      if (typeof e.supportsCacheControl === 'boolean') entry.supportsCacheControl = e.supportsCacheControl;
      const price = (e.price ?? e.pricing) as Record<string, unknown> | undefined;
      if (price && typeof price === 'object') {
        entry.price = {};
        const pi = numberField(price, ['input', 'input_per_1m', 'inputPer1M']);
        const po = numberField(price, ['output', 'output_per_1m', 'outputPer1M']);
        const pr = numberField(price, ['cacheRead', 'cache_read', 'cached_input_per_1m']);
        const pw = numberField(price, ['cacheWrite', 'cache_write']);
        if (pi !== undefined) entry.price.input = pi;
        if (po !== undefined) entry.price.output = po;
        if (pr !== undefined) entry.price.cacheRead = pr;
        if (pw !== undefined) entry.price.cacheWrite = pw;
      }
      out[id.toLowerCase()] = entry;
    }
    configCache = { file, mtimeMs: st.mtimeMs, size: st.size, value: out };
    return out;
  } catch {
    return {};
  }
}

function numberField(o: Record<string, unknown>, keys: string[]): number | undefined {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** `VG_MODEL_ALIAS_MAP` + built-in aliases + gateway unwrapping. Unknown → trimmed lowercase input. */
export function canonicalModelId(model: string, env: NodeJS.ProcessEnv = process.env): string {
  const raw = model.trim().toLowerCase();
  if (!raw) return raw;
  const userMap = knobEnv.map('VG_MODEL_ALIAS_MAP', env);
  for (const [k, v] of Object.entries(userMap)) if (k.trim().toLowerCase() === raw) return v.trim().toLowerCase();
  const config = loadModelsConfig(env);
  for (const [id, entry] of Object.entries(config)) {
    if (id === raw) return id;
    if (entry.aliases?.some((a) => a.toLowerCase() === raw)) return id;
  }
  for (const c of modelIdCandidates(raw)) {
    for (const [k, v] of Object.entries(userMap)) if (k.trim().toLowerCase() === c) return v.trim().toLowerCase();
    const { byId, aliases: aliasMap } = catalogIndex();
    if (byId.has(c)) return c;
    const alias = aliasMap.get(c);
    if (alias) return alias;
    if (config[c]) return c;
  }
  return raw;
}

const LONG_CONTEXT_SUFFIX = /(?:-1m|\[1m\]|-1m-context|:1m)$/;

/** Infer a family + limit for an id the registry does not know. */
export function inferModelInfo(id: string): ModelInfo {
  const s = id.toLowerCase();
  const pick = (family: string, ctx: number, out?: number, thinking?: boolean, cache?: boolean): ModelInfo => {
    const info: ModelInfo = { id, family, contextLimit: ctx };
    if (out !== undefined) info.maxOutput = out;
    if (thinking) info.billsThinking = true;
    if (cache) info.supportsCacheControl = true;
    return info;
  };
  if (/^ollama\//.test(s) || /:latest$|:\d+b$/.test(s)) return pick('ollama', 8192, 4096);
  if (/claude|anthropic/.test(s)) {
    const bills = billsPriorThinking(s);
    if (/opus/.test(s)) return pick('anthropic', bills ? ONE_MILLION : 200 * K, bills ? 128 * K : 32 * K, bills, true);
    if (/sonnet/.test(s)) return pick('anthropic', bills ? ONE_MILLION : 200 * K, bills ? 128 * K : 64 * K, bills, true);
    if (/haiku/.test(s)) return pick('anthropic', 200 * K, 64 * K, false, true);
    return pick('anthropic', bills ? ONE_MILLION : 200 * K, bills ? 128 * K : 32 * K, bills, true);
  }
  if (/^gpt-4\.1/.test(s)) return pick('openai', 1_047_576, 32768);
  // GPT-6 and GPT-5.5+ (a later minor than 5.4) ship the 1.05M window.
  if (/^gpt-[6-9]/.test(s) || /^gpt-5\.(?:[5-9]|\d{2,})/.test(s)) return pick('openai', 1_050_000, 128 * K, true);
  if (/^gpt-5/.test(s)) return pick('openai', 400 * K, 128 * K, true);
  if (/^gpt-4o/.test(s)) return pick('openai', 128 * K, 16384);
  if (/^o[1-9](?:-|$)/.test(s)) return pick('openai', 200 * K, 100 * K, true);
  if (/^gpt-4-32k/.test(s)) return pick('openai', 32768, 4096);
  if (/^gpt-4-turbo|^gpt-4-\d{4}-preview/.test(s)) return pick('openai', 128 * K, 4096);
  if (/^gpt-4/.test(s)) return pick('openai', 8192, 4096);
  if (/^gpt-3\.5/.test(s)) return pick('openai', 16385, 4096);
  if (/^gpt-/.test(s)) return pick('openai', 128 * K, 16384);
  if (/gemini-1\.5-pro/.test(s)) return pick('google', 2 * ONE_MILLION, 8192);
  if (/gemini-1\.0|gemini-pro$/.test(s)) return pick('google', 32768, 4096);
  if (/gemini|gemma/.test(s)) return pick('google', ONE_MILLION, 65536);
  if (/llama-4/.test(s)) return pick('meta', ONE_MILLION, 8192);
  if (/llama|codellama/.test(s)) return pick('meta', 131072, 4096);
  if (/mixtral|mistral-7b|codestral|mistral-small/.test(s)) return pick('mistral', 32768, 4096);
  if (/mistral|ministral|pixtral/.test(s)) return pick('mistral', 131072, 4096);
  if (/deepseek-v4/.test(s)) return pick('deepseek', ONE_MILLION, 384 * K, true);
  if (/deepseek-coder/.test(s)) return pick('deepseek', 16384, 4096);
  if (/deepseek/.test(s)) return pick('deepseek', 131072, 8192, /r1|reason/.test(s));
  if (/grok-4\.(?:[5-9]|\d{2,})/.test(s)) return pick('xai', 500 * K, 32768, true);
  if (/grok-4\.[2-4]/.test(s)) return pick('xai', ONE_MILLION, 32768, true);
  if (/grok-4|grok-code|grok-build/.test(s)) return pick('xai', 256 * K, 32768);
  if (/grok/.test(s)) return pick('xai', 131072, 16384);
  if (/qwen|qwq/.test(s)) return pick('qwen', 131072, 8192);
  if (/kimi|moonshot/.test(s)) return pick('moonshot', 131072, 16384);
  if (/phi-?\d/.test(s)) return pick('microsoft', 131072, 4096);
  return pick('unknown', DEFAULT_CONTEXT_LIMIT, 4096);
}

/**
 * Whether a model bills prior-turn reasoning as input (Claude 4.6+ / 5.x):
 * parse the leading numeric parts of the id split on `-`; true when
 * major ≥ 5 or (major, minor) ≥ (4, 6). Conservative: no numbers → false.
 */
export function billsPriorThinking(model: string): boolean {
  const parts = model.trim().toLowerCase().split('-');
  const nums: number[] = [];
  let started = false;
  for (const p of parts) {
    if (/^\d+$/.test(p) && p.length < 8) {
      nums.push(Number.parseInt(p, 10));
      started = true;
    } else if (started) break;
  }
  if (nums.length === 0) return false;
  const major = nums[0];
  const minor = nums[1] ?? 0;
  return major >= 5 || (major === 4 && minor >= 6);
}

function applyConfigEntry(base: ModelInfo, id: string, entry: ModelsConfigEntry | undefined): ModelInfo {
  if (!entry) return base;
  const out: ModelInfo = { ...base, id: base.id || id };
  if (entry.contextLimit !== undefined && entry.contextLimit > 0) out.contextLimit = Math.trunc(entry.contextLimit);
  if (entry.maxOutput !== undefined && entry.maxOutput > 0) out.maxOutput = Math.trunc(entry.maxOutput);
  if (entry.family) out.family = entry.family;
  if (entry.aliases) out.aliases = [...entry.aliases];
  if (entry.billsThinking !== undefined) out.billsThinking = entry.billsThinking;
  if (entry.supportsCacheControl !== undefined) out.supportsCacheControl = entry.supportsCacheControl;
  return out;
}

/**
 * Registry + pattern inference + overrides. Precedence for the context
 * limit: `VG_MODEL_LIMITS` > `VG_1M_MODEL` / `-1m` suffix > models.json >
 * registry > inference > 128k.
 */
export function modelInfo(model: string, env: NodeJS.ProcessEnv = process.env): ModelInfo {
  const raw = (model ?? '').trim().toLowerCase();
  const canonical = canonicalModelId(raw, env);
  const config = loadModelsConfig(env);

  let info: ModelInfo | undefined;
  const { byId, aliases: aliasMap } = catalogIndex();
  const reg = byId.get(canonical);
  if (reg) info = { ...reg, aliases: reg.aliases ? [...reg.aliases] : undefined };
  if (!info) {
    for (const c of modelIdCandidates(canonical)) {
      const hit = byId.get(c) ?? (aliasMap.has(c) ? byId.get(aliasMap.get(c) as string) : undefined);
      if (hit) {
        info = { ...hit, id: canonical, aliases: hit.aliases ? [...hit.aliases] : undefined };
        break;
      }
      // longest-prefix match at a version boundary (`gpt-4-32k-0613` → `gpt-4-32k`, never `gpt-4.1` → `gpt-4`)
      let best: ModelInfo | undefined;
      for (const [id, row] of byId) {
        if (!c.startsWith(id)) continue;
        const rest = c.slice(id.length);
        if (rest && !['-', '/', ':', '@', '_'].includes(rest[0])) continue;
        if (!best || id.length > best.id.length) best = row;
      }
      if (best) {
        info = { ...best, id: canonical, aliases: best.aliases ? [...best.aliases] : undefined };
        break;
      }
    }
  }
  if (!info) {
    // Nothing catalogued. Inference still has to see through a gateway prefix
    // (`openrouter/openai/gpt-6-astra` → `gpt-6-astra`), which used to happen
    // for free: the static table confirmed the unwrapped candidate, so
    // `canonicalModelId` returned it. With the table gone that confirmation
    // is absent whenever the module is, so try each candidate here and take
    // the first that infers to a recognised family. An id no rule recognises
    // still lands on the conservative default below — the safe direction.
    for (const c of modelIdCandidates(canonical || raw)) {
      const guess = inferModelInfo(c);
      if (guess.family !== 'unknown') {
        info = { ...guess, id: canonical || raw };
        break;
      }
    }
  }
  if (!info) info = inferModelInfo(canonical || raw);
  if (!info.aliases) delete info.aliases;

  // models.json overrides (canonical id, then raw id)
  info = applyConfigEntry(info, canonical, config[canonical]);
  if (raw !== canonical) info = applyConfigEntry(info, canonical, config[raw]);

  // 1M-context markers
  const oneM = new Set(knobEnv.list('VG_1M_MODEL', env).map((s) => s.toLowerCase()));
  if (oneM.has(raw) || oneM.has(canonical) || LONG_CONTEXT_SUFFIX.test(raw) || LONG_CONTEXT_SUFFIX.test(canonical)) {
    info.contextLimit = Math.max(info.contextLimit, ONE_MILLION);
  }

  // explicit limits win
  const limits = knobEnv.map('VG_MODEL_LIMITS', env);
  for (const [k, v] of Object.entries(limits)) {
    const key = k.trim().toLowerCase();
    if (key !== raw && key !== canonical) continue;
    const n = Number.parseInt(v.trim(), 10);
    if (Number.isFinite(n) && n > 0) info.contextLimit = n;
  }
  info.id = canonical || raw;
  return info;
}

/** Context limit shortcut with a default for unknown models. */
export function contextLimitFor(model: string, env: NodeJS.ProcessEnv = process.env): number {
  return modelInfo(model, env).contextLimit;
}
