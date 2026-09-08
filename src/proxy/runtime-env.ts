/**
 * Hot-knob snapshot taken once per request.
 *
 * Layering (highest first): CLI flags reflected into the config env → the
 * process environment at startup → the *latest* `settings.json` (re-read when
 * its mtime changes, so `POST /api/settings` and `vg serve config set` take effect
 * on the next request without a restart) → profile defaults → knob defaults.
 * Only knobs marked `hot` in the registry are re-read; the rest are fixed for
 * the life of the process.
 */

import * as fs from 'node:fs';
import { KNOBS, env as knobEnv, loadSettings, parseMap } from '../compress/config.js';
import { settingsPath } from '../compress/paths.js';
import type { ProfileName, ProxyMode } from '../compress/types.js';
import { knobRegistered } from './config.js';

export interface RuntimeKnobs {
  env: NodeJS.ProcessEnv;
  compress: boolean;
  mode: ProxyMode;
  profile: ProfileName;
  ccr: boolean;
  ccrInlineResolve: boolean;
  ccrMaxRounds: number;
  outputShaper: boolean;
  verbosityLevel: 1 | 2 | 3 | 4;
  verbosityAutotune: boolean;
  holdout: number;
  effortRouting: boolean;
  rpm: number;
  tpm: number;
  concurrency: number;
  budgetUsd: number;
  budgetPeriod: 'hour' | 'day' | 'week' | 'month';
  budgetBasis: 'billed' | 'estimated';
  modelRoutes: Record<string, string>;
  modelRouter: boolean;
  modelRouterRules: string | undefined;
  toolSearch: boolean;
  toolSearchMinTools: number;
  toolDescMaxChars: number;
  toolDescStripSemantic: boolean;
  toolInjectionSticky: boolean;
  systemCompact: boolean;
  systemCompactMinChars: number;
  betaHeaderSticky: boolean;
  cacheControlTtlGuard: boolean;
  semanticCache: boolean;
  semanticCacheTtl: number;
  memory: boolean;
  memoryTopK: number;
  memoryInjectionMode: 'system' | 'user' | 'off';
  memoryNoTools: boolean;
  memoryNoContext: boolean;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  logMessages: boolean;
  logPayloadPreview: number;
  debugDump: boolean;
  audit: boolean;
  savingsTarget: number;
  compressDeadlineMs: number;
}

const HOT_KNOBS = new Set(KNOBS.filter((k) => k.hot).map((k) => k.name));

export class RuntimeEnv {
  private readonly fixed: Set<string>;
  private settingsMtime = -1;
  private settings: Record<string, string> = {};
  private current: NodeJS.ProcessEnv;

  /**
   * @param configEnv the fully layered env from `resolveProxyConfig`
   * @param baseEnv the process env the proxy started with (explicit vars are pinned)
   * @param pinned keys reflected from CLI flags (always win)
   */
  constructor(
    private readonly configEnv: NodeJS.ProcessEnv,
    baseEnv: NodeJS.ProcessEnv = process.env,
    pinned: string[] = [],
  ) {
    this.fixed = new Set<string>(pinned);
    for (const [k, v] of Object.entries(baseEnv)) if (v !== undefined && v !== '' && k.startsWith('VG_')) this.fixed.add(k);
    this.current = { ...configEnv };
    this.refresh();
  }

  /** Re-read settings.json when it changed; cheap (one stat) on the hot path. */
  refresh(): void {
    const file = settingsPath(this.configEnv);
    let mtime = -1;
    try {
      mtime = fs.statSync(file).mtimeMs;
    } catch {
      mtime = -1;
    }
    if (mtime === this.settingsMtime) return;
    this.settingsMtime = mtime;
    const loaded = loadSettings(this.configEnv);
    const next: Record<string, string> = {};
    for (const [k, v] of Object.entries(loaded)) if (v !== null && HOT_KNOBS.has(k)) next[k] = String(v);
    const merged: NodeJS.ProcessEnv = { ...this.configEnv };
    // Hot knobs previously sourced from settings that were removed fall back to the config env.
    for (const [k, v] of Object.entries(next)) if (!this.fixed.has(k)) merged[k] = v;
    for (const k of Object.keys(this.settings)) if (!(k in next) && !this.fixed.has(k)) merged[k] = this.configEnv[k];
    this.settings = next;
    this.current = merged;
  }

  /** The env to hand the pipeline for this request. */
  env(): NodeJS.ProcessEnv {
    this.refresh();
    return this.current;
  }

  snapshot(): RuntimeKnobs {
    const e = this.env();
    const level = knobEnv.enum<'L1' | 'L2' | 'L3' | 'L4'>('VG_OUTPUT_VERBOSITY_LEVEL', e);
    return {
      env: e,
      compress: knobEnv.bool('VG_COMPRESS', e),
      mode: knobEnv.enum<ProxyMode>('VG_COMPRESS_MODE', e),
      profile: knobEnv.enum<ProfileName>('VG_COMPRESS_PROFILE', e),
      ccr: knobEnv.bool('VG_CCR', e),
      ccrInlineResolve: knobEnv.bool('VG_CCR_INLINE_RESOLVE', e),
      ccrMaxRounds: knobEnv.int('VG_CCR_MAX_ROUNDS', e, { min: 0, max: 10 }),
      outputShaper: knobEnv.bool('VG_OUTPUT_SHAPER', e),
      verbosityLevel: Number(level.slice(1)) as 1 | 2 | 3 | 4,
      verbosityAutotune: knobEnv.bool('VG_OUTPUT_VERBOSITY_AUTOTUNE', e),
      holdout: knobEnv.float('VG_OUTPUT_HOLDOUT', e, { min: 0, max: 0.5 }),
      effortRouting: knobEnv.bool('VG_OUTPUT_EFFORT_ROUTING', e),
      rpm: knobEnv.int('VG_PROXY_RPM', e, { min: 0 }),
      tpm: knobEnv.int('VG_PROXY_TPM', e, { min: 0 }),
      concurrency: knobEnv.int('VG_PROXY_LIMIT_CONCURRENCY', e, { min: 0 }),
      budgetUsd: knobEnv.float('VG_PROXY_BUDGET', e, { min: 0 }),
      budgetPeriod: knobEnv.enum<'hour' | 'day' | 'week' | 'month'>('VG_PROXY_BUDGET_PERIOD', e),
      budgetBasis: knobEnv.enum<'billed' | 'estimated'>('VG_PROXY_BUDGET_ESTIMATED_BASIS', e),
      modelRoutes: parseMap(e.VG_PROXY_MODEL_ROUTES),
      modelRouter: knobEnv.bool('VG_PROXY_MODEL_ROUTER', e),
      modelRouterRules: knobRegistered('VG_PROXY_MODEL_ROUTER_RULES') ? knobEnv.string('VG_PROXY_MODEL_ROUTER_RULES', e) : undefined,
      toolSearch: knobEnv.bool('VG_PROXY_TOOL_SEARCH', e),
      toolSearchMinTools: knobEnv.int('VG_PROXY_TOOL_SEARCH_MIN_TOOLS', e, { min: 1 }),
      toolDescMaxChars: knobEnv.int('VG_PROXY_TOOL_DESC_MAX_CHARS', e, { min: 0 }),
      toolDescStripSemantic: knobEnv.bool('VG_PROXY_TOOL_DESC_STRIP_SEMANTIC', e),
      toolInjectionSticky: knobEnv.bool('VG_PROXY_TOOL_INJECTION_STICKY', e),
      systemCompact: knobEnv.bool('VG_PROXY_SYSTEM_COMPACT', e),
      systemCompactMinChars: knobEnv.int('VG_PROXY_SYSTEM_COMPACT_MIN_CHARS', e, { min: 0 }),
      betaHeaderSticky: knobEnv.bool('VG_PROXY_BETA_HEADER_STICKY', e),
      cacheControlTtlGuard: knobEnv.bool('VG_PROXY_CACHE_CONTROL_TTL_GUARD', e),
      semanticCache: knobEnv.bool('VG_PROXY_SEMANTIC_CACHE', e),
      semanticCacheTtl: knobEnv.int('VG_PROXY_SEMANTIC_CACHE_TTL', e, { min: 1 }),
      memory: knobEnv.bool('VG_PROXY_MEMORY', e) || knobEnv.bool('VG_MEMORY', e),
      memoryTopK: knobEnv.int('VG_MEMORY_TOP_K', e, { min: 0, max: 100 }),
      memoryInjectionMode: knobEnv.enum<'system' | 'user' | 'off'>('VG_MEMORY_INJECTION_MODE', e),
      memoryNoTools: knobEnv.bool('VG_MEMORY_NO_TOOLS', e),
      memoryNoContext: knobEnv.bool('VG_MEMORY_NO_CONTEXT', e),
      logLevel: knobEnv.enum<'debug' | 'info' | 'warn' | 'error'>('VG_PROXY_LOG_LEVEL', e),
      logMessages: knobEnv.bool('VG_PROXY_LOG_MESSAGES', e),
      logPayloadPreview: knobEnv.int('VG_PROXY_LOG_PAYLOAD_PREVIEW', e, { min: 0 }),
      debugDump: knobEnv.bool('VG_PROXY_DEBUG_DUMP', e),
      audit: knobEnv.bool('VG_PROXY_AUDIT', e),
      savingsTarget: knobEnv.float('VG_SAVINGS_TARGET', e, { min: 0, max: 1 }),
      compressDeadlineMs: knobEnv.int('VG_COMPRESS_DEADLINE_MS', e, { min: 0 }),
    };
  }

  /** The hot knob names and their current values (for the dashboard editor). */
  hotValues(): Record<string, string | undefined> {
    const e = this.env();
    const out: Record<string, string | undefined> = {};
    for (const name of [...HOT_KNOBS].sort()) out[name] = e[name];
    return out;
  }

  static hotKnobNames(): string[] {
    return [...HOT_KNOBS].sort();
  }
}
