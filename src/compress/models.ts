/**
 * Model registry: context limits, output caps, family, aliases and the
 * thinking-billing flag. Static table + pattern inference for ids we have
 * never seen (`*-1m`, `gpt-4.1-mini`, dated snapshots, gateway prefixes) +
 * user overrides from `VG_MODEL_LIMITS`, `VG_MODEL_ALIAS_MAP`, `VG_1M_MODEL`
 * and the `models.json` file at `modelsConfigPath()`.
 *
 * Unknown models resolve to a conservative 128k window (never throws).
 */

import * as fs from 'node:fs';
import { env as knobEnv } from './config.js';
import { modelsConfigPath } from './paths.js';
import { modelIdCandidates } from './tokenizers.js';

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

interface Row {
  id: string;
  family: string;
  ctx: number;
  out?: number;
  aliases?: string[];
  thinking?: boolean;
  cache?: boolean;
}

const K = 1000;

const ROWS: Row[] = [
  // --- Anthropic (all support cache_control) -------------------------------
  { id: 'claude-fable-5-1', family: 'anthropic', ctx: ONE_MILLION, out: 128 * K, thinking: true, cache: true },
  { id: 'claude-mythos-5-1', family: 'anthropic', ctx: ONE_MILLION, out: 128 * K, thinking: true, cache: true },
  { id: 'claude-fable-5', family: 'anthropic', ctx: ONE_MILLION, out: 128 * K, thinking: true, cache: true },
  { id: 'claude-mythos-5', family: 'anthropic', ctx: ONE_MILLION, out: 128 * K, thinking: true, cache: true },
  { id: 'claude-opus-5', family: 'anthropic', ctx: ONE_MILLION, out: 128 * K, thinking: true, cache: true },
  { id: 'claude-opus-4-8', family: 'anthropic', ctx: ONE_MILLION, out: 128 * K, thinking: true, cache: true },
  { id: 'claude-opus-4-7', family: 'anthropic', ctx: ONE_MILLION, out: 128 * K, thinking: true, cache: true },
  { id: 'claude-opus-4-6', family: 'anthropic', ctx: ONE_MILLION, out: 128 * K, thinking: true, cache: true },
  { id: 'claude-sonnet-5', family: 'anthropic', ctx: ONE_MILLION, out: 128 * K, thinking: true, cache: true },
  { id: 'claude-sonnet-4-6', family: 'anthropic', ctx: ONE_MILLION, out: 128 * K, thinking: true, cache: true },
  { id: 'claude-haiku-4-5', family: 'anthropic', ctx: 200 * K, out: 64 * K, aliases: ['claude-haiku-4-5-20251001'], cache: true },
  { id: 'claude-opus-4-5', family: 'anthropic', ctx: 200 * K, out: 64 * K, aliases: ['claude-opus-4-5-20251101'], cache: true },
  { id: 'claude-opus-4-1', family: 'anthropic', ctx: 200 * K, out: 32 * K, aliases: ['claude-opus-4-1-20250805'], cache: true },
  { id: 'claude-sonnet-4-5', family: 'anthropic', ctx: 200 * K, out: 64 * K, aliases: ['claude-sonnet-4-5-20250929'], cache: true },
  { id: 'claude-sonnet-4-0', family: 'anthropic', ctx: 200 * K, out: 64 * K, aliases: ['claude-sonnet-4-20250514', 'claude-sonnet-4'], cache: true },
  { id: 'claude-opus-4-0', family: 'anthropic', ctx: 200 * K, out: 32 * K, aliases: ['claude-opus-4-20250514', 'claude-opus-4'], cache: true },
  { id: 'claude-3-7-sonnet-20250219', family: 'anthropic', ctx: 200 * K, out: 64 * K, aliases: ['claude-3-7-sonnet-latest', 'claude-3-7-sonnet'], cache: true },
  { id: 'claude-3-5-sonnet-20241022', family: 'anthropic', ctx: 200 * K, out: 8192, aliases: ['claude-3-5-sonnet-latest', 'claude-3-5-sonnet-20240620', 'claude-3-5-sonnet'], cache: true },
  { id: 'claude-3-5-haiku-20241022', family: 'anthropic', ctx: 200 * K, out: 8192, aliases: ['claude-3-5-haiku-latest', 'claude-3-5-haiku'], cache: true },
  { id: 'claude-3-opus-20240229', family: 'anthropic', ctx: 200 * K, out: 4096, aliases: ['claude-3-opus-latest', 'claude-3-opus'], cache: true },
  { id: 'claude-3-haiku-20240307', family: 'anthropic', ctx: 200 * K, out: 4096, aliases: ['claude-3-haiku'], cache: true },
  // --- OpenAI ---------------------------------------------------------------
  { id: 'gpt-5', family: 'openai', ctx: 400 * K, out: 128 * K, thinking: true },
  { id: 'gpt-5-mini', family: 'openai', ctx: 400 * K, out: 128 * K, thinking: true },
  { id: 'gpt-5-nano', family: 'openai', ctx: 400 * K, out: 128 * K, thinking: true },
  { id: 'gpt-4.1', family: 'openai', ctx: 1_047_576, out: 32768 },
  { id: 'gpt-4.1-mini', family: 'openai', ctx: 1_047_576, out: 32768 },
  { id: 'gpt-4.1-nano', family: 'openai', ctx: 1_047_576, out: 32768 },
  { id: 'gpt-4o', family: 'openai', ctx: 128 * K, out: 16384, aliases: ['gpt-4o-2024-11-20', 'gpt-4o-2024-08-06', 'gpt-4o-2024-05-13', 'chatgpt-4o-latest'] },
  { id: 'gpt-4o-mini', family: 'openai', ctx: 128 * K, out: 16384, aliases: ['gpt-4o-mini-2024-07-18'] },
  { id: 'o1', family: 'openai', ctx: 200 * K, out: 100 * K, thinking: true },
  { id: 'o1-mini', family: 'openai', ctx: 128 * K, out: 65536, thinking: true },
  { id: 'o3', family: 'openai', ctx: 200 * K, out: 100 * K, thinking: true },
  { id: 'o3-mini', family: 'openai', ctx: 200 * K, out: 100 * K, thinking: true },
  { id: 'o4-mini', family: 'openai', ctx: 200 * K, out: 100 * K, thinking: true },
  { id: 'gpt-4-turbo', family: 'openai', ctx: 128 * K, out: 4096, aliases: ['gpt-4-turbo-preview', 'gpt-4-turbo-2024-04-09'] },
  { id: 'gpt-4-32k', family: 'openai', ctx: 32768, out: 4096 },
  { id: 'gpt-4', family: 'openai', ctx: 8192, out: 4096, aliases: ['gpt-4-0613'] },
  { id: 'gpt-3.5-turbo', family: 'openai', ctx: 16385, out: 4096, aliases: ['gpt-3.5-turbo-0125', 'gpt-3.5-turbo-1106'] },
  // --- Google ---------------------------------------------------------------
  { id: 'gemini-2.5-pro', family: 'google', ctx: ONE_MILLION, out: 65536, thinking: true },
  { id: 'gemini-2.5-flash', family: 'google', ctx: ONE_MILLION, out: 65536, thinking: true },
  { id: 'gemini-2.5-flash-lite', family: 'google', ctx: ONE_MILLION, out: 65536 },
  { id: 'gemini-2.0-flash', family: 'google', ctx: ONE_MILLION, out: 8192, aliases: ['gemini-2.0-flash-exp', 'gemini-2.0-flash-001'] },
  { id: 'gemini-1.5-pro', family: 'google', ctx: 2 * ONE_MILLION, out: 8192, aliases: ['gemini-1.5-pro-latest'] },
  { id: 'gemini-1.5-flash', family: 'google', ctx: ONE_MILLION, out: 8192, aliases: ['gemini-1.5-flash-latest'] },
  // --- Meta -----------------------------------------------------------------
  { id: 'llama-4-maverick', family: 'meta', ctx: ONE_MILLION, out: 8192 },
  { id: 'llama-4-scout', family: 'meta', ctx: 10 * ONE_MILLION, out: 8192 },
  { id: 'llama-3.3-70b', family: 'meta', ctx: 128 * K, out: 4096, aliases: ['llama-3.3-70b-instruct', 'meta-llama/llama-3.3-70b-instruct'] },
  { id: 'llama-3.1-405b', family: 'meta', ctx: 128 * K, out: 4096, aliases: ['llama-3.1-405b-instruct', 'meta-llama/llama-3.1-405b-instruct'] },
  { id: 'llama-3.1-70b', family: 'meta', ctx: 128 * K, out: 4096, aliases: ['llama-3.1-70b-instruct', 'meta-llama/llama-3.1-70b-instruct'] },
  { id: 'llama-3.1-8b', family: 'meta', ctx: 128 * K, out: 4096, aliases: ['llama-3.1-8b-instruct', 'meta-llama/llama-3.1-8b-instruct'] },
  // --- Mistral --------------------------------------------------------------
  { id: 'mistral-large', family: 'mistral', ctx: 128 * K, out: 4096, aliases: ['mistral-large-latest'] },
  { id: 'mistral-medium', family: 'mistral', ctx: 128 * K, out: 4096, aliases: ['mistral-medium-latest'] },
  { id: 'mistral-small', family: 'mistral', ctx: 32768, out: 4096, aliases: ['mistral-small-latest'] },
  { id: 'codestral', family: 'mistral', ctx: 32768, out: 4096, aliases: ['codestral-latest'] },
  { id: 'ministral-8b', family: 'mistral', ctx: 128 * K, out: 4096 },
  { id: 'mixtral-8x7b', family: 'mistral', ctx: 32768, out: 4096, aliases: ['mixtral-8x7b-instruct'] },
  { id: 'mistral-7b', family: 'mistral', ctx: 32768, out: 4096, aliases: ['mistral-7b-instruct'] },
  // --- DeepSeek -------------------------------------------------------------
  { id: 'deepseek-v4-flash', family: 'deepseek', ctx: ONE_MILLION, out: 384 * K, thinking: true },
  { id: 'deepseek-v4-pro', family: 'deepseek', ctx: ONE_MILLION, out: 384 * K, thinking: true },
  { id: 'deepseek-chat', family: 'deepseek', ctx: 128 * K, out: 8192, aliases: ['deepseek-v3'] },
  { id: 'deepseek-reasoner', family: 'deepseek', ctx: 128 * K, out: 65536, aliases: ['deepseek-r1'], thinking: true },
  { id: 'deepseek-coder', family: 'deepseek', ctx: 16384, out: 4096 },
  // --- xAI ------------------------------------------------------------------
  { id: 'grok-4', family: 'xai', ctx: 256 * K, out: 32768, thinking: true },
  { id: 'grok-3', family: 'xai', ctx: 131072, out: 16384 },
  { id: 'grok-3-mini', family: 'xai', ctx: 131072, out: 16384, thinking: true },
  { id: 'grok-code-fast-1', family: 'xai', ctx: 256 * K, out: 32768 },
  // --- Qwen / Moonshot ------------------------------------------------------
  { id: 'qwen3-235b', family: 'qwen', ctx: 131072, out: 16384, aliases: ['qwen3-235b-a22b'] },
  { id: 'qwen2.5-72b', family: 'qwen', ctx: 131072, out: 8192, aliases: ['qwen2.5-72b-instruct'] },
  { id: 'qwen2.5-coder', family: 'qwen', ctx: 131072, out: 8192, aliases: ['qwen2.5-coder-32b-instruct'] },
  { id: 'qwen2.5-7b', family: 'qwen', ctx: 131072, out: 8192, aliases: ['qwen2.5-7b-instruct'] },
  { id: 'qwq-32b', family: 'qwen', ctx: 131072, out: 16384, thinking: true },
  { id: 'kimi-k2', family: 'moonshot', ctx: 128 * K, out: 16384, aliases: ['moonshot-v1-128k'] },
  // --- Ollama (local) — ids as `ollama/<name>` or bare tag-less names -------
  { id: 'ollama/llama3', family: 'ollama', ctx: 8192, out: 4096 },
  { id: 'ollama/llama3.1', family: 'ollama', ctx: 131072, out: 4096 },
  { id: 'ollama/llama3.2', family: 'ollama', ctx: 131072, out: 4096 },
  { id: 'ollama/llama3.3', family: 'ollama', ctx: 131072, out: 4096 },
  { id: 'ollama/mistral', family: 'ollama', ctx: 32768, out: 4096 },
  { id: 'ollama/qwen2.5', family: 'ollama', ctx: 32768, out: 4096 },
  { id: 'ollama/qwen2.5-coder', family: 'ollama', ctx: 32768, out: 4096 },
  { id: 'ollama/qwen3', family: 'ollama', ctx: 40960, out: 4096 },
  { id: 'ollama/codellama', family: 'ollama', ctx: 16384, out: 4096 },
  { id: 'ollama/gemma3', family: 'ollama', ctx: 131072, out: 4096 },
  { id: 'ollama/gemma2', family: 'ollama', ctx: 8192, out: 4096 },
  { id: 'ollama/phi3', family: 'ollama', ctx: 131072, out: 4096 },
  { id: 'ollama/phi4', family: 'ollama', ctx: 16384, out: 4096 },
  { id: 'ollama/deepseek-r1', family: 'ollama', ctx: 131072, out: 4096 },
];

function toInfo(r: Row): ModelInfo {
  const info: ModelInfo = { id: r.id, family: r.family, contextLimit: r.ctx };
  if (r.out !== undefined) info.maxOutput = r.out;
  if (r.aliases) info.aliases = [...r.aliases];
  if (r.thinking) info.billsThinking = true;
  if (r.cache) info.supportsCacheControl = true;
  return info;
}

const REGISTRY: ReadonlyMap<string, ModelInfo> = new Map(ROWS.map((r) => [r.id, toInfo(r)]));
const ALIASES: ReadonlyMap<string, string> = (() => {
  const m = new Map<string, string>();
  for (const r of ROWS) for (const a of r.aliases ?? []) m.set(a.toLowerCase(), r.id);
  return m;
})();

/** Every built-in model (sorted by id). */
export function knownModels(): ModelInfo[] {
  return [...REGISTRY.values()]
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
    if (REGISTRY.has(c)) return c;
    const alias = ALIASES.get(c);
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
  if (/grok-4|grok-code/.test(s)) return pick('xai', 256 * K, 32768);
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
  const reg = REGISTRY.get(canonical);
  if (reg) info = { ...reg, aliases: reg.aliases ? [...reg.aliases] : undefined };
  if (!info) {
    for (const c of modelIdCandidates(canonical)) {
      const hit = REGISTRY.get(c) ?? (ALIASES.has(c) ? REGISTRY.get(ALIASES.get(c) as string) : undefined);
      if (hit) {
        info = { ...hit, id: canonical, aliases: hit.aliases ? [...hit.aliases] : undefined };
        break;
      }
      // longest-prefix match at a version boundary (`gpt-4-32k-0613` → `gpt-4-32k`, never `gpt-4.1` → `gpt-4`)
      let best: ModelInfo | undefined;
      for (const [id, row] of REGISTRY) {
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
