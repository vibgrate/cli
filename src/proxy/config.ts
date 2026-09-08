/**
 * `ProxyConfig` (DESIGN.md §3.3) and its resolution.
 *
 * Precedence, highest first: explicit overrides (CLI flags) → `VG_*`
 * environment → `settings.json` (applied set-if-absent) → the active savings
 * profile's defaults → knob defaults. The resolved `env` carries every layer
 * below the flags so the rest of the proxy reads one object.
 */

import { activeProfile, applySettings, env as knobEnv, envWithProfile, isProfileName, loadSettings, parseMap, KNOBS } from '../compress/config.js';
import type { ProfileName, ProxyMode } from '../compress/types.js';

export interface ProxyConfig {
  host: string;
  port: number;
  token?: string;
  mode: ProxyMode;
  profile: ProfileName;
  optimize: boolean;
  ccr: boolean;
  lossless: boolean;
  memory: boolean;
  outputShaper: boolean;
  stateless: boolean;
  offline: boolean;
  anthropicUrl: string;
  openaiUrl: string;
  upstreamUrl?: string;
  provider?: string;
  logFile?: string;
  budgetUsd?: number;
  rpm?: number;
  tpm?: number;
  modelRoutes: Record<string, string>;
  workspace?: string;
  project?: string;
  agentType?: string;
  env: NodeJS.ProcessEnv;
}

/** rstrip `/`, then strip a trailing `/v1` (providers append it themselves). */
export function normalizeApiUrl(url: string): string {
  let u = url.trim().replace(/\/+$/, '');
  if (/\/v1$/i.test(u)) u = u.slice(0, -3);
  return u;
}

/** Legacy / conventional upstream env vars honoured after the `VG_*` knobs. */
const ANTHROPIC_URL_ENVS = ['VG_PROXY_ANTHROPIC_API_URL', 'ANTHROPIC_TARGET_API_URL', 'ANTHROPIC_FOUNDRY_BASE_URL'];
const OPENAI_URL_ENVS = ['VG_PROXY_OPENAI_API_URL', 'OPENAI_TARGET_API_URL'];

function firstSet(e: NodeJS.ProcessEnv, names: string[]): string | undefined {
  for (const n of names) {
    const v = e[n]?.trim();
    if (v) return v;
  }
  return undefined;
}

/** Whether `name` is a registered knob (so reading it is on the documented surface). */
export function knobRegistered(name: string): boolean {
  return KNOBS.some((k) => k.name === name);
}

/**
 * Build the effective environment for a proxy run: process env, with
 * `settings.json` layered underneath (set-if-absent) and profile defaults
 * beneath that. The caller's env object is never mutated.
 */
export function layeredEnv(base: NodeJS.ProcessEnv = process.env, explicitProfile?: string): NodeJS.ProcessEnv {
  const withSettings: NodeJS.ProcessEnv = { ...base };
  applySettings(loadSettings(base), withSettings);
  const profile = activeProfile(explicitProfile, withSettings);
  return envWithProfile(profile, withSettings);
}

export function resolveProxyConfig(overrides: Partial<ProxyConfig> = {}, baseEnv: NodeJS.ProcessEnv = process.env): ProxyConfig {
  const e = layeredEnv(baseEnv, overrides.profile);
  const profile = activeProfile(overrides.profile, e).name;
  const modeFromEnv = knobEnv.enum<ProxyMode>('VG_COMPRESS_MODE', e);
  const budget = knobEnv.float('VG_PROXY_BUDGET', e, { min: 0 });
  const rpm = knobEnv.int('VG_PROXY_RPM', e, { min: 0 });
  const tpm = knobEnv.int('VG_PROXY_TPM', e, { min: 0 });
  const anthropicUrl = normalizeApiUrl(firstSet(e, ANTHROPIC_URL_ENVS) ?? 'https://api.anthropic.com');
  const openaiUrl = normalizeApiUrl(firstSet(e, OPENAI_URL_ENVS) ?? 'https://api.openai.com');
  const upstream = knobEnv.string('VG_PROXY_UPSTREAM_BASE_URL', e);

  const cfg: ProxyConfig = {
    host: knobEnv.string('VG_PROXY_HOST', e) ?? '127.0.0.1',
    port: knobEnv.int('VG_PROXY_PORT', e, { min: 0, max: 65535 }),
    token: knobEnv.string('VG_PROXY_TOKEN', e),
    mode: modeFromEnv,
    profile: isProfileName(profile) ? profile : 'coding',
    optimize: knobEnv.bool('VG_COMPRESS', e),
    ccr: knobEnv.bool('VG_CCR', e),
    lossless: knobEnv.bool('VG_COMPRESS_LOSSLESS', e),
    memory: knobEnv.bool('VG_PROXY_MEMORY', e) || knobEnv.bool('VG_MEMORY', e),
    outputShaper: knobEnv.bool('VG_OUTPUT_SHAPER', e),
    stateless: knobEnv.bool('VG_PROXY_STATELESS', e),
    offline: knobEnv.bool('VG_PROXY_OFFLINE', e),
    anthropicUrl,
    openaiUrl,
    upstreamUrl: upstream ? normalizeApiUrl(upstream) : undefined,
    provider: knobEnv.string('VG_PROXY_PROVIDER', e)?.toLowerCase(),
    logFile: knobEnv.string('VG_PROXY_LOG_FILE', e),
    budgetUsd: budget > 0 ? budget : undefined,
    rpm: rpm > 0 ? rpm : undefined,
    tpm: tpm > 0 ? tpm : undefined,
    modelRoutes: parseMap(e.VG_PROXY_MODEL_ROUTES),
    workspace: knobEnv.string('VG_PROXY_WORKSPACE', e),
    project: knobEnv.string('VG_PROXY_PROJECT', e),
    agentType: knobEnv.string('VG_PROXY_AGENT_TYPE', e),
    env: e,
  };

  // Flags win over everything; `undefined` in overrides means "not given".
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined || k === 'env') continue;
    (cfg as unknown as Record<string, unknown>)[k] = v;
  }
  if (overrides.anthropicUrl) cfg.anthropicUrl = normalizeApiUrl(overrides.anthropicUrl);
  if (overrides.openaiUrl) cfg.openaiUrl = normalizeApiUrl(overrides.openaiUrl);
  if (overrides.upstreamUrl) cfg.upstreamUrl = normalizeApiUrl(overrides.upstreamUrl);
  if (overrides.provider) cfg.provider = overrides.provider.toLowerCase();
  if (overrides.modelRoutes) cfg.modelRoutes = { ...cfg.modelRoutes, ...overrides.modelRoutes };
  if (overrides.env) cfg.env = { ...cfg.env, ...overrides.env };

  // Reflect flag-level decisions back into the env so hot knob snapshots and
  // the pipeline (which read env) agree with the running configuration.
  const reflect: Record<string, string> = {
    VG_PROXY_HOST: cfg.host,
    VG_PROXY_PORT: String(cfg.port),
    VG_COMPRESS_MODE: cfg.mode,
    VG_COMPRESS_PROFILE: cfg.profile,
    VG_COMPRESS: String(cfg.optimize),
    VG_CCR: String(cfg.ccr),
    VG_COMPRESS_LOSSLESS: String(cfg.lossless),
    VG_PROXY_MEMORY: String(cfg.memory),
    VG_OUTPUT_SHAPER: String(cfg.outputShaper),
    VG_PROXY_STATELESS: String(cfg.stateless),
    VG_PROXY_OFFLINE: String(cfg.offline),
    VG_PROXY_ANTHROPIC_API_URL: cfg.anthropicUrl,
    VG_PROXY_OPENAI_API_URL: cfg.openaiUrl,
  };
  if (cfg.token) reflect.VG_PROXY_TOKEN = cfg.token;
  if (cfg.upstreamUrl) reflect.VG_PROXY_UPSTREAM_BASE_URL = cfg.upstreamUrl;
  if (cfg.provider) reflect.VG_PROXY_PROVIDER = cfg.provider;
  if (cfg.logFile) reflect.VG_PROXY_LOG_FILE = cfg.logFile;
  if (cfg.budgetUsd !== undefined) reflect.VG_PROXY_BUDGET = String(cfg.budgetUsd);
  if (cfg.rpm !== undefined) reflect.VG_PROXY_RPM = String(cfg.rpm);
  if (cfg.tpm !== undefined) reflect.VG_PROXY_TPM = String(cfg.tpm);
  if (cfg.workspace) reflect.VG_PROXY_WORKSPACE = cfg.workspace;
  if (cfg.project) reflect.VG_PROXY_PROJECT = cfg.project;
  if (cfg.agentType) reflect.VG_PROXY_AGENT_TYPE = cfg.agentType;
  if (Object.keys(cfg.modelRoutes).length) reflect.VG_PROXY_MODEL_ROUTES = Object.entries(cfg.modelRoutes).map(([a, b]) => `${a}=${b}`).join(',');
  cfg.env = { ...cfg.env, ...reflect };
  return cfg;
}

/** True when the bind address is loopback-only. */
export function isLoopbackBind(host: string): boolean {
  const h = host.trim().toLowerCase();
  return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]' || h.startsWith('127.');
}

/** Human-readable summary rows for `vg serve config`. */
export function configSummary(cfg: ProxyConfig): Array<{ key: string; value: string }> {
  return [
    { key: 'host', value: cfg.host },
    { key: 'port', value: String(cfg.port) },
    { key: 'token', value: cfg.token ? '<set>' : '<none>' },
    { key: 'mode', value: cfg.mode },
    { key: 'profile', value: cfg.profile },
    { key: 'optimize', value: String(cfg.optimize) },
    { key: 'ccr', value: String(cfg.ccr) },
    { key: 'lossless', value: String(cfg.lossless) },
    { key: 'memory', value: String(cfg.memory) },
    { key: 'outputShaper', value: String(cfg.outputShaper) },
    { key: 'stateless', value: String(cfg.stateless) },
    { key: 'offline', value: String(cfg.offline) },
    { key: 'anthropicUrl', value: cfg.anthropicUrl },
    { key: 'openaiUrl', value: cfg.openaiUrl },
    { key: 'upstreamUrl', value: cfg.upstreamUrl ?? '' },
    { key: 'provider', value: cfg.provider ?? 'auto' },
    { key: 'logFile', value: cfg.logFile ?? '' },
    { key: 'budgetUsd', value: cfg.budgetUsd === undefined ? 'off' : String(cfg.budgetUsd) },
    { key: 'rpm', value: cfg.rpm === undefined ? 'off' : String(cfg.rpm) },
    { key: 'tpm', value: cfg.tpm === undefined ? 'off' : String(cfg.tpm) },
    { key: 'modelRoutes', value: Object.entries(cfg.modelRoutes).map(([a, b]) => `${a}→${b}`).join(', ') },
    { key: 'workspace', value: cfg.workspace ?? '' },
    { key: 'project', value: cfg.project ?? '' },
    { key: 'agentType', value: cfg.agentType ?? '' },
  ];
}
