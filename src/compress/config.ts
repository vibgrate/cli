/**
 * Configuration for the context-compression layer.
 *
 * Three layers, in precedence order (highest first):
 *   1. explicit CLI flags / API options (callers pass resolved values);
 *   2. `VG_*` environment variables (this file's knob registry);
 *   3. `settings.json` (user-editable, applied to `process.env` with
 *      set-if-absent semantics so a real env var always wins);
 *   4. the savings profile defaults (`coding` | `balanced` | `aggressive` | `general`).
 *
 * The knob registry is the single source of truth for names, types, defaults
 * and one-line descriptions; `vg serve config` and the docs generator
 * read it, so add new knobs here rather than reading `process.env` ad hoc.
 *
 * Nothing in this module reads the wall clock or touches the network.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { settingsPath } from './paths.js';
import type { ProfileName, ProxyMode, ToolProfile } from './types.js';

// ---------------------------------------------------------------------------
// Primitive parsers (tolerant, never throw)
// ---------------------------------------------------------------------------

const TRUE = new Set(['1', 'true', 'yes', 'on', 'y', 't']);
const FALSE = new Set(['0', 'false', 'no', 'off', 'n', 'f', '']);

export function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  const v = raw.trim().toLowerCase();
  if (TRUE.has(v)) return true;
  if (FALSE.has(v)) return false;
  return fallback;
}

export function parseInt10(raw: string | undefined, fallback: number, opts: { min?: number; max?: number } = {}): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(n)) return fallback;
  if (opts.min !== undefined && n < opts.min) return opts.min;
  if (opts.max !== undefined && n > opts.max) return opts.max;
  return n;
}

export function parseFloatSafe(raw: string | undefined, fallback: number, opts: { min?: number; max?: number } = {}): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number.parseFloat(raw.trim());
  if (!Number.isFinite(n)) return fallback;
  if (opts.min !== undefined && n < opts.min) return opts.min;
  if (opts.max !== undefined && n > opts.max) return opts.max;
  return n;
}

/** Comma/whitespace separated list, trimmed, empties dropped, order kept. */
export function parseList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** `a=b,c=d` → record; also accepts JSON objects. */
export function parseMap(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  const t = raw.trim();
  if (t.startsWith('{')) {
    try {
      const obj = JSON.parse(t) as Record<string, unknown>;
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(obj)) out[k] = String(v);
      return out;
    } catch {
      return {};
    }
  }
  const out: Record<string, string> = {};
  for (const pair of t.split(',')) {
    const i = pair.indexOf('=');
    if (i <= 0) continue;
    const k = pair.slice(0, i).trim();
    const v = pair.slice(i + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

/** JSON value or fallback — used for structured knobs (tool profiles, prices). */
export function parseJson<T>(raw: string | undefined, fallback: T): T {
  if (!raw || !raw.trim()) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Knob registry
// ---------------------------------------------------------------------------

export type KnobType = 'bool' | 'int' | 'float' | 'string' | 'list' | 'map' | 'json' | 'enum' | 'path';

export type KnobScope = 'compress' | 'ccr' | 'proxy' | 'output' | 'memory' | 'learn' | 'wrap' | 'savings' | 'telemetry' | 'runtime';

export interface Knob {
  /** Environment variable name (`VG_…`). */
  name: string;
  type: KnobType;
  scope: KnobScope;
  /** Default as the env string would be written; `undefined` = unset. */
  default?: string;
  /** Allowed values for `enum`. */
  values?: readonly string[];
  /** One-line description shown by `vg serve config` and in DOCS.md. */
  description: string;
  /** Changing this knob after the proxy started takes effect on the next request. */
  hot?: boolean;
  /** Hidden from user-facing listings (internal / test-only). */
  internal?: boolean;
}

function k(name: string, type: KnobType, scope: KnobScope, description: string, extra: Partial<Knob> = {}): Knob {
  return { name, type, scope, description, ...extra };
}

/**
 * Every knob the layer honours. Names are stable public surface — renaming one
 * is a breaking change. Keep the list sorted by scope, then name.
 */
export const KNOBS: readonly Knob[] = [
  // --- compress ------------------------------------------------------------
  k('VG_COMPRESS', 'bool', 'compress', 'Master switch; off forces passthrough (A/B baseline).', { default: 'true', hot: true }),
  k('VG_COMPRESS_MODE', 'enum', 'compress', 'cache = compress only the newest delta (prefix-cache safe); token = maximize removal.', { default: 'cache', values: ['cache', 'token'], hot: true }),
  k('VG_COMPRESS_PROFILE', 'enum', 'compress', 'Savings profile: coding | balanced | aggressive | general.', { default: 'coding', values: ['coding', 'balanced', 'aggressive', 'general'], hot: true }),
  k('VG_COMPRESS_TARGET_RATIO', 'float', 'compress', 'Keep ratio for text compression (0.1..1). Unset = adaptive.', { hot: true }),
  k('VG_COMPRESS_MIN_TOKENS', 'int', 'compress', 'Per-message floor (tokens) before any compression is attempted.', { default: '500', hot: true }),
  k('VG_COMPRESS_MIN_CHARS_FOR_BLOCK', 'int', 'compress', 'Per-block floor (chars) for list-shaped content blocks.', { default: '200', hot: true }),
  k('VG_COMPRESS_MAX_ITEMS', 'int', 'compress', 'Max items kept by the JSON array compressor per block.', { default: '50', hot: true }),
  k('VG_CODE_COMPRESS', 'bool', 'compress', 'Compress bulky tool results inside the `vg code` agent loop before they enter the transcript. Reads that an edit is computed from are always byte-exact.', { default: 'true', hot: true }),
  k('VG_CODE_COMPRESS_MIN_CHARS', 'int', 'compress', 'Size (chars) a `vg code` tool result must reach before in-loop compression is attempted.', { default: '4000', hot: true }),
  k('VG_CODE_RETRIEVE_MAX_TOKENS', 'int', 'compress', 'Cap (tokens) on what one `vg_retrieve` call inside `vg code` returns; the model narrows with grep / lines / head / tail for more.', { default: '4000', hot: true }),
  k('VG_COMPRESS_USER_MESSAGES', 'bool', 'compress', 'Allow compression of user-role text (default: only pasted tool output inside it).', { default: 'false', hot: true }),
  k('VG_COMPRESS_SYSTEM_MESSAGES', 'bool', 'compress', 'Allow compression of system/developer prompts.', { default: 'false', hot: true }),
  k('VG_COMPRESS_ASSISTANT_TEXT', 'bool', 'compress', 'Allow compression of assistant text blocks.', { default: 'false', hot: true }),
  k('VG_COMPRESS_PROTECT_RECENT', 'int', 'compress', 'Never compress code inside the last N messages.', { default: '3', hot: true }),
  k('VG_COMPRESS_PROTECT_ANALYSIS_CONTEXT', 'bool', 'compress', 'Keep tool outputs the user is actively asking about.', { default: 'true', hot: true }),
  k('VG_COMPRESS_PROTECT_TOOL_RESULTS', 'list', 'compress', 'Tool names whose output is never lossy-compressed.', { hot: true }),
  k('VG_COMPRESS_PROTECT_READS', 'bool', 'compress', 'Keep file reads (cat/head/Read) byte-exact so read-then-edit works.', { default: 'true', hot: true }),
  k('VG_COMPRESS_READ_MIN_CHARS', 'int', 'compress', 'Reads smaller than this are never touched.', { default: '2000', hot: true }),
  k('VG_COMPRESS_EXCLUDE_TOOLS', 'list', 'compress', 'Tool names skipped entirely (no folds either).', { hot: true }),
  k('VG_COMPRESS_COMPRESSORS', 'list', 'compress', 'Restrict to these strategies (smart_crusher,code_aware,search,log,diff,html,tabular,config,text).', { hot: true }),
  k('VG_COMPRESS_CODE_AWARE', 'bool', 'compress', 'AST-aware code compression using the bundled grammars.', { default: 'true', hot: true }),
  k('VG_COMPRESS_PREFER_CODE_AWARE', 'bool', 'compress', 'Prefer the AST compressor over lossless folds for source code.', { default: 'false', hot: true }),
  k('VG_COMPRESS_TEXT', 'bool', 'compress', 'Extractive plain-text compression (deterministic, query-aware).', { default: 'true', hot: true }),
  k('VG_COMPRESS_LOSSLESS', 'bool', 'compress', 'Only byte-reversible folds; never a marker, never lossy.', { default: 'false', hot: true }),
  k('VG_COMPRESS_LOSSLESS_THEN_LOSSY', 'bool', 'compress', 'Run lossy on top of a fold when it beats it by ≥ VG_COMPRESS_LOSSY_MIN_EXTRA_SAVINGS.', { default: 'true', hot: true }),
  k('VG_COMPRESS_LOSSY_MIN_EXTRA_SAVINGS', 'float', 'compress', 'Extra fraction lossy must save over lossless to be chosen.', { default: '0.15', hot: true }),
  k('VG_COMPRESS_LOSSLESS_GUARD_LOSSY', 'bool', 'compress', 'Reject a lossy result that fails the recoverability check.', { default: 'true', hot: true }),
  k('VG_COMPRESS_DEDUPE', 'bool', 'compress', 'Cross-turn dedup of verbatim repeated tool output.', { default: 'true', hot: true }),
  k('VG_COMPRESS_READ_LIFECYCLE', 'bool', 'compress', 'Replace stale reads (files edited later) with a marker.', { default: 'true', hot: true }),
  k('VG_COMPRESS_READ_SUPERSEDED', 'bool', 'compress', 'Also replace reads fully covered by a later read (busts prefix cache).', { default: 'false', hot: true }),
  k('VG_COMPRESS_READ_MATURATION', 'bool', 'compress', 'Hold new reads byte-exact for a few turns before they become compressible.', { default: 'true', hot: true }),
  k('VG_COMPRESS_READ_MATURATION_QUIESCE_TURNS', 'int', 'compress', 'Turns without edits before a read matures.', { default: '2', hot: true }),
  k('VG_COMPRESS_READ_MATURATION_MAX_HOLD_TURNS', 'int', 'compress', 'Upper bound on how long a read is held.', { default: '6', hot: true }),
  k('VG_COMPRESS_READ_MATURATION_MIN_SIZE_BYTES', 'int', 'compress', 'Reads smaller than this mature immediately.', { default: '4096', hot: true }),
  k('VG_COMPRESS_THINKING_COMPACT', 'bool', 'compress', 'Compact prior-turn reasoning on models that bill it.', { default: 'false', hot: true }),
  k('VG_COMPRESS_THINKING_COMPACT_KEEP_LAST', 'int', 'compress', 'Reasoning blocks kept verbatim at the tail.', { default: '1', hot: true }),
  k('VG_COMPRESS_FREEZE_BLOCK_DECISION', 'bool', 'compress', 'Freeze per-block verdicts across turns (prefix-cache stability).', { default: 'true', hot: true }),
  k('VG_COMPRESS_FROZEN_VERDICTS_MAX', 'int', 'compress', 'Cap on remembered frozen verdicts per session.', { default: '4096' }),
  k('VG_COMPRESS_SMART_CRUSHER_COMPACTION', 'bool', 'compress', 'Emit csv-schema compaction for uniform JSON arrays.', { default: 'true', hot: true }),
  k('VG_COMPRESS_COMPACTION_FORMAT', 'enum', 'compress', 'Render format for compacted arrays.', { default: 'csv-schema', values: ['csv-schema', 'json'], hot: true }),
  k('VG_COMPRESS_TOOL_PROFILES', 'json', 'compress', 'JSON map of tool name → {skipCompression,losslessOnly,maxItemsAfterCrush,minTokensToCompress,bias,preserveKeywords}.', { hot: true }),
  k('VG_COMPRESS_DEADLINE_MS', 'int', 'compress', 'Per-request compression budget; on overrun the original is forwarded.', { default: '2000', hot: true }),
  k('VG_COMPRESS_ACCURACY_GUARD', 'bool', 'compress', 'Reject rewrites that drop error/ID anchors.', { default: 'true', hot: true }),
  k('VG_MODEL_LIMITS', 'map', 'compress', 'Context-window overrides: model=tokens,…', { hot: true }),
  k('VG_MODEL_ALIAS_MAP', 'map', 'compress', 'Alias → canonical model id.', { hot: true }),
  k('VG_MODEL_PRICES', 'json', 'compress', 'JSON price overrides: {model:{input,output,cacheRead,cacheWrite}} per 1M tokens.', { hot: true }),
  k('VG_1M_MODEL', 'list', 'compress', 'Model ids to treat as 1M-context.', { hot: true }),

  // --- ccr -----------------------------------------------------------------
  k('VG_CCR', 'bool', 'ccr', 'Compress-cache-retrieve: keep originals retrievable via markers.', { default: 'true', hot: true }),
  k('VG_CCR_TTL_SECONDS', 'int', 'ccr', 'Seconds a stored original stays retrievable.', { default: '1800' }),
  k('VG_CCR_MAX_ENTRIES', 'int', 'ccr', 'LRU cap on stored originals (memory + disk).', { default: '1000' }),
  k('VG_CCR_MAX_ENTRY_BYTES', 'int', 'ccr', 'Originals larger than this are not stored (block stays uncompressed).', { default: '5000000' }),
  k('VG_CCR_BACKEND', 'enum', 'ccr', 'memory (per-process) or disk (shared across vg processes).', { default: 'disk', values: ['memory', 'disk'] }),
  k('VG_CCR_INLINE_RESOLVE', 'bool', 'ccr', 'Resolve retrieval tool calls inside the proxy without a client round-trip.', { default: 'true', hot: true }),
  k('VG_CCR_PROACTIVE_EXPANSION', 'bool', 'ccr', 'Expand a compressed block in place when the user asks about it.', { default: 'true', hot: true }),
  k('VG_CCR_MAX_ROUNDS', 'int', 'ccr', 'Max retrieval rounds handled per request.', { default: '3', hot: true }),
  k('VG_CCR_BUFFERED_GRACE_SECONDS', 'float', 'ccr', 'Grace before a buffered retrieval turn emits heartbeat pings.', { default: '5' }),

  // --- proxy ---------------------------------------------------------------
  k('VG_PROXY_HOST', 'string', 'proxy', 'Bind address (loopback by default; non-loopback requires VG_PROXY_TOKEN).', { default: '127.0.0.1' }),
  k('VG_PROXY_PORT', 'int', 'proxy', 'Listen port.', { default: '8787' }),
  k('VG_PROXY_TOKEN', 'string', 'proxy', 'Bearer token clients must present; required off-loopback.'),
  k('VG_PROXY_URL', 'string', 'proxy', 'URL wrapped agents use to reach the proxy.'),
  k('VG_PROXY_ALLOWED_BASE_URLS', 'list', 'proxy', 'Allow-list of upstream base URLs (SSRF guard).'),
  k('VG_PROXY_UPSTREAM_ALLOWED_HOSTS', 'list', 'proxy', 'Extra upstream hostnames permitted beyond the built-in provider list.'),
  k('VG_PROXY_TLS_STRICT', 'bool', 'proxy', 'Reject self-signed upstreams.', { default: 'true' }),
  k('VG_PROXY_HTTP_PROXY', 'string', 'proxy', 'Outbound HTTP(S) proxy for upstream calls.'),
  k('VG_PROXY_REQUEST_TIMEOUT', 'float', 'proxy', 'Upstream request timeout (seconds).', { default: '600' }),
  k('VG_PROXY_CONNECT_TIMEOUT_SECONDS', 'float', 'proxy', 'Upstream connect timeout.', { default: '10' }),
  k('VG_PROXY_WRITE_TIMEOUT_SECONDS', 'float', 'proxy', 'Client write timeout.', { default: '600' }),
  k('VG_PROXY_MAX_BODY_BYTES', 'int', 'proxy', 'Reject request bodies larger than this.', { default: '104857600' }),
  k('VG_PROXY_BODY_TOO_LARGE_STATUS', 'int', 'proxy', 'Status returned for oversize bodies.', { default: '413' }),
  k('VG_PROXY_SSE_BUFFER_MAX_BYTES', 'int', 'proxy', 'Max buffered SSE bytes before the stream is passed through raw.', { default: '8388608' }),
  k('VG_PROXY_CORS_ORIGINS', 'list', 'proxy', 'Allowed CORS origins for the dashboard API.'),
  k('VG_PROXY_STRIP_INTERNAL_HEADERS', 'bool', 'proxy', 'Strip x-vg-* headers before forwarding upstream.', { default: 'true' }),
  k('VG_PROXY_TRUSTED_GATEWAY_CIDRS', 'list', 'proxy', 'CIDRs allowed to set forwarded headers.'),
  k('VG_PROXY_TRUSTED_DASHBOARD_CLIENT_CIDRS', 'list', 'proxy', 'CIDRs treated as loopback for admin routes.'),
  k('VG_PROXY_STATELESS', 'bool', 'proxy', 'No session state; every request compressed independently.', { default: 'false' }),
  k('VG_PROXY_OFFLINE', 'bool', 'proxy', 'Never call the network for anything but the configured upstream.', { default: 'false' }),
  k('VG_PROXY_SKIP_UPSTREAM_CHECK', 'bool', 'proxy', 'Skip the startup reachability probe.', { default: 'false' }),
  k('VG_PROXY_RPM', 'int', 'proxy', 'Requests-per-minute limit (0 = off).', { default: '0', hot: true }),
  k('VG_PROXY_TPM', 'int', 'proxy', 'Tokens-per-minute limit (0 = off).', { default: '0', hot: true }),
  k('VG_PROXY_LIMIT_CONCURRENCY', 'int', 'proxy', 'Max in-flight upstream requests (0 = unlimited).', { default: '0', hot: true }),
  k('VG_PROXY_BUDGET', 'float', 'proxy', 'USD spend cap per VG_PROXY_BUDGET_PERIOD (0 = off).', { default: '0', hot: true }),
  k('VG_PROXY_BUDGET_PERIOD', 'enum', 'proxy', 'Budget window.', { default: 'day', values: ['hour', 'day', 'week', 'month'], hot: true }),
  k('VG_PROXY_BUDGET_ESTIMATED_BASIS', 'enum', 'proxy', 'Count estimated or billed tokens against the budget.', { default: 'billed', values: ['billed', 'estimated'], hot: true }),
  k('VG_PROXY_MODEL_ROUTES', 'map', 'proxy', 'Model rewrite map: requested=served,…', { hot: true }),
  k('VG_PROXY_MODEL_ROUTER', 'bool', 'proxy', 'Enable heuristic model routing.', { default: 'false', hot: true }),
  k('VG_PROXY_TOOL_SEARCH', 'bool', 'proxy', 'Defer tools behind a search tool when the tool list is large.', { default: 'true', hot: true }),
  k('VG_PROXY_TOOL_SEARCH_MIN_TOOLS', 'int', 'proxy', 'Tool-count threshold for deferral.', { default: '12', hot: true }),
  k('VG_PROXY_TOOL_DESC_MAX_CHARS', 'int', 'proxy', 'Trim tool descriptions to this many chars (0 = off).', { default: '0', hot: true }),
  k('VG_PROXY_TOOL_DESC_STRIP_SEMANTIC', 'bool', 'proxy', 'Strip boilerplate sentences from tool descriptions.', { default: 'true', hot: true }),
  k('VG_PROXY_TOOL_INJECTION_STICKY', 'bool', 'proxy', 'Keep injected retrieval tool present for the session once added.', { default: 'true', hot: true }),
  k('VG_PROXY_SYSTEM_COMPACT', 'bool', 'proxy', 'Compact repeated whitespace/boilerplate in system prompts.', { default: 'true', hot: true }),
  k('VG_PROXY_SYSTEM_COMPACT_MIN_CHARS', 'int', 'proxy', 'System prompt floor for compaction.', { default: '8000', hot: true }),
  k('VG_PROXY_BETA_HEADER_STICKY', 'bool', 'proxy', 'Remember anthropic-beta headers per session.', { default: 'true', hot: true }),
  k('VG_PROXY_CACHE_CONTROL_TTL_GUARD', 'bool', 'proxy', 'Refuse to downgrade cache_control ttl inside a session.', { default: 'true', hot: true }),
  k('VG_PROXY_SEMANTIC_CACHE', 'bool', 'proxy', 'Serve identical requests from a local response cache.', { default: 'false', hot: true }),
  k('VG_PROXY_SEMANTIC_CACHE_TTL', 'int', 'proxy', 'Response cache TTL (seconds).', { default: '3600', hot: true }),
  k('VG_PROXY_SESSION_TTL_SECONDS', 'int', 'proxy', 'Idle session eviction.', { default: '3600' }),
  k('VG_PROXY_MAX_SESSIONS', 'int', 'proxy', 'Session cap (LRU).', { default: '1000' }),
  k('VG_PROXY_LOG_FILE', 'path', 'proxy', 'Rotating request log path.'),
  k('VG_PROXY_LOG_LEVEL', 'enum', 'proxy', 'Log level.', { default: 'info', values: ['debug', 'info', 'warn', 'error'], hot: true }),
  k('VG_PROXY_LOG_MESSAGES', 'bool', 'proxy', 'Include (redacted) message previews in the request log.', { default: 'false', hot: true }),
  k('VG_PROXY_LOG_PAYLOAD_PREVIEW', 'int', 'proxy', 'Chars of payload preview per line.', { default: '0', hot: true }),
  k('VG_PROXY_DEBUG_DUMP', 'bool', 'proxy', 'Dump redacted 4xx request/response pairs for debugging.', { default: 'false', hot: true }),
  k('VG_PROXY_AUDIT', 'bool', 'proxy', 'Append per-request audit lines (hashes only).', { default: 'false', hot: true }),
  k('VG_PROXY_METRICS', 'bool', 'proxy', 'Expose /metrics (Prometheus text format).', { default: 'true' }),
  k('VG_PROXY_WORKSPACE', 'path', 'proxy', 'Workspace root used for project attribution.'),
  k('VG_PROXY_PROJECT', 'string', 'proxy', 'Project label override for savings attribution.'),
  k('VG_PROXY_AGENT_TYPE', 'string', 'proxy', 'Client label override (claude, codex, …).'),
  k('VG_PROXY_MEMORY', 'bool', 'proxy', 'Inject relevant memories and expose memory tools.', { default: 'false', hot: true }),
  k('VG_PROXY_ANTHROPIC_API_URL', 'string', 'proxy', 'Anthropic upstream base URL.', { default: 'https://api.anthropic.com' }),
  k('VG_PROXY_OPENAI_API_URL', 'string', 'proxy', 'OpenAI upstream base URL.', { default: 'https://api.openai.com' }),
  k('VG_PROXY_UPSTREAM_BASE_URL', 'string', 'proxy', 'Generic upstream override for /v1/* routes.'),
  k('VG_PROXY_PROVIDER', 'string', 'proxy', 'Force a provider (anthropic, openai, bedrock, vertex, gemini, ollama, …).'),

  // --- output shaper --------------------------------------------------------
  k('VG_OUTPUT_SHAPER', 'bool', 'output', 'Verbosity steering + effort routing for cheaper outputs.', { default: 'false', hot: true }),
  k('VG_OUTPUT_VERBOSITY_LEVEL', 'enum', 'output', 'Steering strength L1 (lightest) .. L4.', { default: 'L2', values: ['L1', 'L2', 'L3', 'L4'], hot: true }),
  k('VG_OUTPUT_VERBOSITY_AUTOTUNE', 'bool', 'output', 'Learn the verbosity level from observed outputs.', { default: 'false', hot: true }),
  k('VG_OUTPUT_HOLDOUT', 'float', 'output', 'Fraction of turns left unsteered to estimate savings (0..0.5).', { default: '0.1', hot: true }),
  k('VG_OUTPUT_EFFORT_ROUTING', 'bool', 'output', 'Clamp reasoning effort on trivial turns (never raises it).', { default: 'false', hot: true }),

  // --- memory --------------------------------------------------------------
  k('VG_MEMORY', 'bool', 'memory', 'Master switch for cross-agent memory.', { default: 'false', hot: true }),
  k('VG_MEMORY_INJECTION_MODE', 'enum', 'memory', 'How memories reach the model.', { default: 'system', values: ['system', 'user', 'off'], hot: true }),
  k('VG_MEMORY_TOP_K', 'int', 'memory', 'Memories injected per request.', { default: '5', hot: true }),
  k('VG_MEMORY_PROJECT_ROOT', 'path', 'memory', 'Project root for scoping (default: git toplevel of cwd).'),
  k('VG_MEMORY_USER_ID', 'string', 'memory', 'User scope key.'),
  k('VG_MEMORY_NO_TOOLS', 'bool', 'memory', 'Do not expose memory_search / memory_save tools.', { default: 'false', hot: true }),
  k('VG_MEMORY_NO_CONTEXT', 'bool', 'memory', 'Do not inject memories (tools only).', { default: 'false', hot: true }),
  k('VG_MEMORY_MIN_EVIDENCE', 'int', 'memory', 'Observations required before a learned rule is promoted.', { default: '3', hot: true }),

  // --- learn ---------------------------------------------------------------
  k('VG_LEARN_TARGET', 'string', 'learn', 'Default instructions file written by `vg install <agent> --learn`.', { default: 'CLAUDE.local.md' }),
  k('VG_LEARN_CLI', 'string', 'learn', 'Local CLI used to summarise sessions (default: heuristic analyzer, no LLM).'),
  k('VG_LEARN_CLI_TIMEOUT_SECS', 'int', 'learn', 'Timeout for the analyzer CLI.', { default: '120' }),
  k('VG_LEARN_CLI_IDLE_TIMEOUT_SECS', 'int', 'learn', 'Idle timeout for the analyzer CLI.', { default: '30' }),

  // --- wrap ----------------------------------------------------------------
  k('VG_WRAP_PROXY_TIMEOUT', 'float', 'wrap', 'Seconds to wait for the proxy to become ready.', { default: '15' }),
  k('VG_WRAP_QUIET', 'bool', 'wrap', 'Suppress the wrap banner.', { default: 'false' }),
  k('VG_WRAP_ACTIVE', 'bool', 'wrap', 'Set by a one-session compression run in the child environment (read-only marker).', { internal: true }),
  k('VG_WRAP_CAPTURE_FILE', 'path', 'wrap', 'Set when a session is captured: the proxy appends one redacted exchange record per upstream call to this JSONL file.', { internal: true }),
  k('VG_COPILOT_AUTH_FILE', 'path', 'wrap', 'Location of the Copilot OAuth token file.'),
  k('VG_SUBSCRIPTION_TRACKING', 'bool', 'wrap', 'Track subscription usage windows.', { default: 'true' }),
  k('VG_SUBSCRIPTION_POLL_INTERVAL', 'int', 'wrap', 'Seconds between subscription window polls.', { default: '300' }),

  // --- savings / telemetry / runtime -----------------------------------------
  k('VG_SAVINGS_TARGET', 'float', 'savings', 'Target saved fraction shown on the dashboard gauge.', { default: '0.3', hot: true }),
  k('VG_SAVINGS_EVENTS_PATH', 'path', 'savings', 'Append-only savings ledger override.'),
  k('VG_PROXY_SAVINGS_PATH', 'path', 'savings', 'Durable proxy totals override.'),
  k('VG_CONTEXT_DIR', 'path', 'runtime', 'Root for all context-compression state.'),
  k('VG_CONTEXT_SETTINGS_PATH', 'path', 'runtime', 'settings.json override.'),
  k('VG_UPDATE_CHECK', 'bool', 'runtime', 'Allow the proxy to check for a newer vg (opt-in).', { default: 'false' }),
  k('VG_UNSAFE_ALLOW_UNSTABLE_FEATURES', 'bool', 'runtime', 'Enable experimental knobs.', { default: 'false', internal: true }),
  k('VG_FEATURES', 'list', 'runtime', 'Feature flags to force on.', { internal: true }),
  k('VG_DISABLE_FEATURES', 'list', 'runtime', 'Feature flags to force off.', { internal: true }),
];

const KNOB_INDEX: ReadonlyMap<string, Knob> = new Map(KNOBS.map((x) => [x.name, x]));

export function knob(name: string): Knob {
  const found = KNOB_INDEX.get(name);
  if (!found) throw new Error(`unknown knob ${name}`);
  return found;
}

export function knobsForScope(scope: KnobScope): Knob[] {
  return KNOBS.filter((x) => x.scope === scope);
}

/** Typed accessors that honour the registry default. */
export const env = {
  bool(name: string, e: NodeJS.ProcessEnv = process.env): boolean {
    const d = knob(name).default;
    return parseBool(e[name], d === undefined ? false : parseBool(d, false));
  },
  int(name: string, e: NodeJS.ProcessEnv = process.env, opts?: { min?: number; max?: number }): number {
    const d = knob(name).default;
    return parseInt10(e[name], d === undefined ? 0 : parseInt10(d, 0), opts);
  },
  float(name: string, e: NodeJS.ProcessEnv = process.env, opts?: { min?: number; max?: number }): number {
    const d = knob(name).default;
    return parseFloatSafe(e[name], d === undefined ? 0 : parseFloatSafe(d, 0), opts);
  },
  /** `undefined` when unset and no default. */
  optFloat(name: string, e: NodeJS.ProcessEnv = process.env): number | undefined {
    const raw = e[name] ?? knob(name).default;
    if (raw === undefined || raw.trim() === '') return undefined;
    const n = Number.parseFloat(raw);
    return Number.isFinite(n) ? n : undefined;
  },
  optInt(name: string, e: NodeJS.ProcessEnv = process.env): number | undefined {
    const raw = e[name] ?? knob(name).default;
    if (raw === undefined || raw.trim() === '') return undefined;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? n : undefined;
  },
  string(name: string, e: NodeJS.ProcessEnv = process.env): string | undefined {
    const raw = e[name] ?? knob(name).default;
    const t = raw?.trim();
    return t ? t : undefined;
  },
  enum<T extends string>(name: string, e: NodeJS.ProcessEnv = process.env): T {
    const kn = knob(name);
    const raw = e[name]?.trim();
    if (raw && kn.values?.includes(raw)) return raw as T;
    // case-insensitive match
    if (raw && kn.values) {
      const hit = kn.values.find((v) => v.toLowerCase() === raw.toLowerCase());
      if (hit) return hit as T;
    }
    return (kn.default ?? kn.values?.[0] ?? '') as T;
  },
  list(name: string, e: NodeJS.ProcessEnv = process.env): string[] {
    return parseList(e[name] ?? knob(name).default);
  },
  map(name: string, e: NodeJS.ProcessEnv = process.env): Record<string, string> {
    return parseMap(e[name] ?? knob(name).default);
  },
  json<T>(name: string, fallback: T, e: NodeJS.ProcessEnv = process.env): T {
    return parseJson<T>(e[name] ?? knob(name).default, fallback);
  },
  /** True when the variable is explicitly set (used for precedence decisions). */
  isSet(name: string, e: NodeJS.ProcessEnv = process.env): boolean {
    return e[name] !== undefined && e[name] !== '';
  },
};

/** Validate an env against the registry; returns human-readable problems (never throws). */
export function validateEnv(e: NodeJS.ProcessEnv = process.env): string[] {
  const problems: string[] = [];
  for (const kn of KNOBS) {
    const raw = e[kn.name];
    if (raw === undefined || raw === '') continue;
    switch (kn.type) {
      case 'bool':
        if (!TRUE.has(raw.trim().toLowerCase()) && !FALSE.has(raw.trim().toLowerCase())) problems.push(`${kn.name}: expected a boolean, got ${JSON.stringify(raw)}`);
        break;
      case 'int':
        if (!/^-?\d+$/.test(raw.trim())) problems.push(`${kn.name}: expected an integer, got ${JSON.stringify(raw)}`);
        break;
      case 'float':
        if (!Number.isFinite(Number.parseFloat(raw))) problems.push(`${kn.name}: expected a number, got ${JSON.stringify(raw)}`);
        break;
      case 'enum':
        if (kn.values && !kn.values.some((v) => v.toLowerCase() === raw.trim().toLowerCase())) problems.push(`${kn.name}: expected one of ${kn.values.join('|')}, got ${JSON.stringify(raw)}`);
        break;
      case 'json':
        try {
          JSON.parse(raw);
        } catch {
          problems.push(`${kn.name}: expected JSON`);
        }
        break;
      default:
        break;
    }
  }
  return problems;
}

/** Snapshot of every knob's effective value (for `--show-config` / doctor). */
export function effectiveConfig(e: NodeJS.ProcessEnv = process.env, opts: { includeInternal?: boolean; redact?: boolean } = {}): Array<{ name: string; value: string | undefined; source: 'env' | 'default' | 'unset'; scope: KnobScope; hot: boolean }> {
  const rows: Array<{ name: string; value: string | undefined; source: 'env' | 'default' | 'unset'; scope: KnobScope; hot: boolean }> = [];
  for (const kn of KNOBS) {
    if (kn.internal && !opts.includeInternal) continue;
    const raw = e[kn.name];
    let value: string | undefined;
    let source: 'env' | 'default' | 'unset';
    if (raw !== undefined && raw !== '') {
      value = raw;
      source = 'env';
    } else if (kn.default !== undefined) {
      value = kn.default;
      source = 'default';
    } else {
      value = undefined;
      source = 'unset';
    }
    if (opts.redact !== false && value && /TOKEN|KEY|SECRET|AUTH/.test(kn.name)) value = '<redacted>';
    rows.push({ name: kn.name, value, source, scope: kn.scope, hot: kn.hot === true });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// settings.json
// ---------------------------------------------------------------------------

/**
 * `settings.json` is a flat `{ "VG_…": "value" }` map (values may be JSON
 * scalars; they are stringified). Unknown keys are kept (forward compatible)
 * but never applied to the environment.
 */
export type Settings = Record<string, string | number | boolean | null>;

export function loadSettings(e: NodeJS.ProcessEnv = process.env): Settings {
  const file = settingsPath(e);
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Settings = {};
    for (const [key, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[key] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export function saveSettings(settings: Settings, e: NodeJS.ProcessEnv = process.env): string {
  const file = settingsPath(e);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const sorted: Settings = {};
  for (const key of Object.keys(settings).sort()) sorted[key] = settings[key];
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(sorted, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* best effort on platforms without POSIX modes */
  }
  return file;
}

/**
 * Apply settings to `target` with set-if-absent semantics: a variable already
 * present in the environment always wins. Only registry knobs are applied.
 * Returns the names that were applied.
 */
export function applySettings(settings: Settings, target: NodeJS.ProcessEnv = process.env): string[] {
  const applied: string[] = [];
  for (const [key, v] of Object.entries(settings)) {
    if (!KNOB_INDEX.has(key)) continue;
    if (v === null) continue;
    if (target[key] !== undefined && target[key] !== '') continue;
    target[key] = typeof v === 'string' ? v : String(v);
    applied.push(key);
  }
  return applied.sort();
}

/** Convenience: load + apply. Safe to call repeatedly. */
export function bootstrapSettings(target: NodeJS.ProcessEnv = process.env): string[] {
  return applySettings(loadSettings(target), target);
}

/** `vg serve config set KEY VALUE` / `vg serve config unset KEY` helpers. */
export function setSetting(key: string, value: string | null, e: NodeJS.ProcessEnv = process.env): { file: string; problems: string[] } {
  const problems: string[] = [];
  if (!KNOB_INDEX.has(key)) problems.push(`unknown setting ${key}; run \`vg serve config\` for the list`);
  else if (value !== null) problems.push(...validateEnv({ [key]: value }));
  if (problems.length) return { file: settingsPath(e), problems };
  const current = loadSettings(e);
  if (value === null) delete current[key];
  else current[key] = value;
  return { file: saveSettings(current, e), problems };
}

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

export interface ProfileDefinition {
  name: ProfileName;
  description: string;
  mode: ProxyMode;
  /** Applied when the corresponding env knob is not set. */
  defaults: Record<string, string>;
  /** Per-tool profiles layered under user-provided VG_COMPRESS_TOOL_PROFILES. */
  toolProfiles: Record<string, ToolProfile>;
  /** Default protect-recent window. */
  protectRecent: number;
  /** Bias applied to the adaptive keep budget (1 = neutral). */
  bias: number;
}

const READ_TOOLS = ['Read', 'read_file', 'cat', 'head', 'tail', 'view_file', 'open_file', 'str_replace_editor', 'read'];
const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'apply_patch', 'write_file', 'edit_file', 'create_file', 'replace_in_file'];

function byteExact(names: string[]): Record<string, ToolProfile> {
  const out: Record<string, ToolProfile> = {};
  for (const n of names) out[n] = { skipCompression: true };
  return out;
}

function losslessOnly(names: string[]): Record<string, ToolProfile> {
  const out: Record<string, ToolProfile> = {};
  for (const n of names) out[n] = { losslessOnly: true };
  return out;
}

/**
 * Savings profiles. `coding` is the default: cache-mode, reads and edits
 * byte-exact, searches folded losslessly, logs/JSON compressed with markers.
 */
export const PROFILES: Readonly<Record<ProfileName, ProfileDefinition>> = {
  coding: {
    name: 'coding',
    description: 'Default. Prefix-cache safe; file reads and edits stay byte-exact; tool output compressed with retrievable markers.',
    mode: 'cache',
    protectRecent: 3,
    bias: 1,
    defaults: { VG_COMPRESS_MODE: 'cache', VG_COMPRESS_PROTECT_READS: 'true', VG_COMPRESS_PROTECT_RECENT: '3', VG_COMPRESS_LOSSLESS_THEN_LOSSY: 'true' },
    toolProfiles: { ...byteExact(EDIT_TOOLS), ...losslessOnly(READ_TOOLS) },
  },
  balanced: {
    name: 'balanced',
    description: 'Cache-mode with lossy compression allowed on older reads; moderate keep budgets.',
    mode: 'cache',
    protectRecent: 2,
    bias: 0.85,
    defaults: { VG_COMPRESS_MODE: 'cache', VG_COMPRESS_PROTECT_READS: 'true', VG_COMPRESS_PROTECT_RECENT: '2', VG_COMPRESS_READ_SUPERSEDED: 'true' },
    toolProfiles: { ...byteExact(EDIT_TOOLS) },
  },
  aggressive: {
    name: 'aggressive',
    description: 'Token-mode; compresses every eligible block including old reads and assistant text. Best for long autonomous runs.',
    mode: 'token',
    protectRecent: 1,
    bias: 0.6,
    defaults: {
      VG_COMPRESS_MODE: 'token',
      VG_COMPRESS_PROTECT_READS: 'false',
      VG_COMPRESS_PROTECT_RECENT: '1',
      VG_COMPRESS_READ_SUPERSEDED: 'true',
      VG_COMPRESS_ASSISTANT_TEXT: 'true',
      VG_COMPRESS_THINKING_COMPACT: 'true',
      VG_COMPRESS_MIN_TOKENS: '300',
    },
    toolProfiles: { ...byteExact(EDIT_TOOLS) },
  },
  general: {
    name: 'general',
    description: 'Non-coding chat: no read/edit protections, text compression on, user messages eligible.',
    mode: 'token',
    protectRecent: 2,
    bias: 0.9,
    defaults: { VG_COMPRESS_MODE: 'token', VG_COMPRESS_PROTECT_READS: 'false', VG_COMPRESS_USER_MESSAGES: 'true', VG_COMPRESS_TEXT: 'true' },
    toolProfiles: {},
  },
};

export function isProfileName(x: unknown): x is ProfileName {
  return typeof x === 'string' && Object.prototype.hasOwnProperty.call(PROFILES, x);
}

/** Resolve the active profile: explicit > env > `coding`. */
export function activeProfile(explicit?: string, e: NodeJS.ProcessEnv = process.env): ProfileDefinition {
  if (explicit && isProfileName(explicit)) return PROFILES[explicit];
  const fromEnv = env.enum<ProfileName>('VG_COMPRESS_PROFILE', e);
  return PROFILES[isProfileName(fromEnv) ? fromEnv : 'coding'];
}

/**
 * Layer profile defaults under the environment (set-if-absent) and return a
 * new env object; the caller's env is never mutated.
 */
export function envWithProfile(profile: ProfileDefinition, e: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...e };
  for (const [key, v] of Object.entries(profile.defaults)) {
    if (out[key] === undefined || out[key] === '') out[key] = v;
  }
  return out;
}

/** Merge profile tool profiles with user overrides (user wins per tool). */
export function resolveToolProfiles(profile: ProfileDefinition, e: NodeJS.ProcessEnv = process.env): Record<string, ToolProfile> {
  const user = env.json<Record<string, ToolProfile>>('VG_COMPRESS_TOOL_PROFILES', {}, e);
  const out: Record<string, ToolProfile> = { ...profile.toolProfiles };
  for (const name of env.list('VG_COMPRESS_PROTECT_TOOL_RESULTS', e)) out[name] = { ...(out[name] ?? {}), losslessOnly: true };
  for (const name of env.list('VG_COMPRESS_EXCLUDE_TOOLS', e)) out[name] = { ...(out[name] ?? {}), skipCompression: true };
  if (user && typeof user === 'object') {
    for (const [name, p] of Object.entries(user)) {
      if (p && typeof p === 'object') out[name] = { ...(out[name] ?? {}), ...p };
    }
  }
  return out;
}

/** Well-known read/edit tool names (shared by the pipeline and the read lifecycle). */
export const READ_TOOL_NAMES: readonly string[] = READ_TOOLS;
export const EDIT_TOOL_NAMES: readonly string[] = EDIT_TOOLS;
