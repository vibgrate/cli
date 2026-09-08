/**
 * GitHub Copilot OAuth for `vg install copilot-cli --compress --login`: the device flow, the
 * private token file, token discovery (safest source first), the short-lived
 * API-token exchange and the API-host policy.
 *
 * All network I/O goes through an injected `fetch`; time and sleep are
 * injected too, so the whole flow is unit-testable offline. The token is
 * never printed — only a `sha256:<12 hex>` fingerprint.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { contextDir } from '../compress/paths.js';
import { CliError, ExitCode } from '../util/exit.js';
import { readJsonSafe, writePrivateFile } from './edit.js';

export const COPILOT_DEFAULT_API_URL = 'https://api.githubcopilot.com';
export const COPILOT_COMPLETIONS_PROXY_URL = 'https://copilot-proxy.githubusercontent.com';
export const COPILOT_TOKEN_EXCHANGE_URL = 'https://api.github.com/copilot_internal/v2/token';
export const COPILOT_USER_INFO_URL = 'https://api.github.com/copilot_internal/user';
export const COPILOT_DEFAULT_GITHUB_HOST = 'github.com';
export const COPILOT_CHAT_OAUTH_CLIENT_ID = 'Iv1.b507a08c87ecfe98';
export const COPILOT_TOKEN_EXPIRY_BUFFER_S = 60;
export const COPILOT_DEFAULT_EDITOR_VERSION = 'vscode/1.107.0';
export const COPILOT_DEFAULT_USER_AGENT = 'GitHubCopilotChat/0.35.0';
export const COPILOT_DEFAULT_EDITOR_PLUGIN_VERSION = 'copilot-chat/0.35.0';
export const COPILOT_DEFAULT_INTEGRATION_ID = 'vscode-chat';
const DEVICE_CODE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

const API_TOKEN_ENV_VARS = ['GITHUB_COPILOT_API_TOKEN', 'COPILOT_PROVIDER_BEARER_TOKEN'] as const;
const COPILOT_OAUTH_TOKEN_ENV_VARS = ['GITHUB_COPILOT_GITHUB_TOKEN', 'GITHUB_COPILOT_TOKEN', 'COPILOT_GITHUB_TOKEN'] as const;
const GENERIC_GITHUB_TOKEN_ENV_VARS = ['GH_TOKEN', 'GITHUB_TOKEN'] as const;
const OAUTH_TOKEN_KEYS = ['oauth_token', 'oauthToken', 'token', 'access_token', 'accessToken'] as const;
const EXPIRY_KEYS = ['expires_at', 'expiresAt', 'expiry', 'expires'] as const;

export type FetchFn = typeof fetch;

export interface AuthDeps {
  fetch?: FetchFn;
  /** Milliseconds since epoch. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** Line printer for the interactive login (default: stderr). */
  log?: (line: string) => void;
  /** `gh auth token` runner (tests inject; `null` skips the `gh` step; default shells out, best effort). */
  exec?: ((cmd: string, args: string[]) => string | null) | null;
}

// ---------------------------------------------------------------------------
// Hosts and URLs
// ---------------------------------------------------------------------------

function normalizeHost(raw: string | undefined): string | undefined {
  const h = raw
    ?.trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '')
    .toLowerCase();
  return h && /^[a-z0-9.-]+(:\d+)?$/.test(h) ? h : undefined;
}

/** Enterprise domain from `GITHUB_COPILOT_ENTERPRISE_URL` / `_DOMAIN`, if any. */
export function copilotEnterpriseDomain(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return normalizeHost(env.GITHUB_COPILOT_ENTERPRISE_URL) ?? normalizeHost(env.GITHUB_COPILOT_ENTERPRISE_DOMAIN);
}

/** GitHub host for OAuth: `GITHUB_COPILOT_HOST` → enterprise domain → derived from the API URL → github.com. */
export function copilotGithubHost(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = normalizeHost(env.GITHUB_COPILOT_HOST);
  if (explicit) return explicit;
  const ent = copilotEnterpriseDomain(env);
  if (ent) return ent;
  const api = normalizeHost(env.GITHUB_COPILOT_API_URL);
  if (api && !api.endsWith('githubcopilot.com')) return api.replace(/^copilot-api\./, '').replace(/^api\./, '');
  return COPILOT_DEFAULT_GITHUB_HOST;
}

export function copilotOauthUrls(domain: string): { deviceCode: string; accessToken: string } {
  const d = normalizeHost(domain) ?? COPILOT_DEFAULT_GITHUB_HOST;
  return { deviceCode: `https://${d}/login/device/code`, accessToken: `https://${d}/login/oauth/access_token` };
}

export function copilotTokenExchangeUrl(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.GITHUB_COPILOT_TOKEN_EXCHANGE_URL?.trim();
  if (override) return override;
  const ent = copilotEnterpriseDomain(env);
  return ent ? `https://api.${ent}/copilot_internal/v2/token` : COPILOT_TOKEN_EXCHANGE_URL;
}

export function copilotUserInfoUrl(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.GITHUB_COPILOT_USER_INFO_URL?.trim();
  if (override) return override;
  const ent = copilotEnterpriseDomain(env);
  return ent ? `https://api.${ent}/copilot_internal/user` : COPILOT_USER_INFO_URL;
}

const SEGMENTED_HOSTS = new Set(['api.githubcopilot.com', 'api.individual.githubcopilot.com', 'api.business.githubcopilot.com', 'api.enterprise.githubcopilot.com']);

export function isCopilotApiUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'githubcopilot.com' || host.endsWith('.githubcopilot.com');
  } catch {
    return false;
  }
}

/**
 * API-host policy: an explicit `GITHUB_COPILOT_API_URL` always wins; the
 * segmented public hosts collapse to the generic one (the segmented host does
 * not serve newer models on the responses API); any other `*.githubcopilot.com`
 * tenant is kept; anything else falls back to the default.
 */
export function copilotApiHost(env: NodeJS.ProcessEnv = process.env, advertised?: string): string {
  const explicit = env.GITHUB_COPILOT_API_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, '');
  if (!advertised) return COPILOT_DEFAULT_API_URL;
  try {
    const u = new URL(advertised);
    const host = u.hostname.toLowerCase();
    if (SEGMENTED_HOSTS.has(host)) return COPILOT_DEFAULT_API_URL;
    if (host.endsWith('.githubcopilot.com')) return `${u.protocol}//${u.host}`;
  } catch {
    /* invalid → default */
  }
  return COPILOT_DEFAULT_API_URL;
}

// ---------------------------------------------------------------------------
// Token file
// ---------------------------------------------------------------------------

export interface CopilotAuthFile {
  created_at: number;
  domain: string;
  provider: 'github-copilot';
  refresh: string;
  type: 'oauth';
}

export function copilotAuthFile(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.VG_COPILOT_AUTH_FILE?.trim();
  return explicit ? path.resolve(explicit) : path.join(contextDir(env), 'copilot_auth.json');
}

export function saveCopilotToken(token: string, domain: string, deps: AuthDeps = {}): string {
  const t = token.trim();
  if (!t) throw new CliError('refusing to save an empty Copilot token', ExitCode.ERROR);
  const env = deps.env ?? process.env;
  const file = copilotAuthFile(env);
  const body: CopilotAuthFile = {
    created_at: Math.floor((deps.now ?? Date.now)() / 1000),
    domain: normalizeHost(domain) ?? COPILOT_DEFAULT_GITHUB_HOST,
    provider: 'github-copilot',
    refresh: t,
    type: 'oauth',
  };
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(body).sort()) sorted[k] = body[k as keyof CopilotAuthFile];
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writePrivateFile(file, `${JSON.stringify(sorted, null, 2)}\n`);
  return file;
}

/** The saved OAuth token, only when the file says `type: oauth` and the value is non-blank. */
export function readCopilotToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const payload = readJsonSafe<Partial<CopilotAuthFile>>(copilotAuthFile(env));
  if (!payload || payload.type !== 'oauth') return null;
  return typeof payload.refresh === 'string' && payload.refresh.trim() ? payload.refresh.trim() : null;
}

export function tokenFingerprint(token: string): string {
  return `sha256:${createHash('sha256').update(token, 'utf8').digest('hex').slice(0, 12)}`;
}

// ---------------------------------------------------------------------------
// Device flow
// ---------------------------------------------------------------------------

interface DeviceStart {
  verificationUri: string;
  userCode: string;
  deviceCode: string;
  interval: number;
  expiresIn: number;
}

function formHeaders(): Record<string, string> {
  return { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': COPILOT_DEFAULT_USER_AGENT };
}

async function postForm(fetchFn: FetchFn, url: string, form: Record<string, string>, timeoutMs = 10_000): Promise<Record<string, unknown>> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, { method: 'POST', headers: formHeaders(), body: new URLSearchParams(form).toString(), signal: ctrl.signal });
    const data = (await res.json()) as unknown;
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new CliError('GitHub device authorization returned an invalid response.', ExitCode.ERROR);
    return data as Record<string, unknown>;
  } finally {
    clearTimeout(timer);
  }
}

export async function startDeviceAuthorization(domain: string, deps: AuthDeps = {}): Promise<DeviceStart> {
  const fetchFn = deps.fetch ?? fetch;
  const data = await postForm(fetchFn, copilotOauthUrls(domain).deviceCode, { client_id: COPILOT_CHAT_OAUTH_CLIENT_ID, scope: 'read:user' });
  const verificationUri = data.verification_uri;
  const userCode = data.user_code;
  const deviceCode = data.device_code;
  if (typeof verificationUri !== 'string' || typeof userCode !== 'string' || typeof deviceCode !== 'string') {
    throw new CliError('GitHub device login returned an incomplete response.', ExitCode.ERROR);
  }
  const interval = typeof data.interval === 'number' ? data.interval : 5;
  const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : 900;
  return { verificationUri, userCode, deviceCode, interval, expiresIn };
}

export async function pollDeviceAuthorization(deviceCode: string, domain: string, opts: { interval?: number; expiresIn?: number } = {}, deps: AuthDeps = {}): Promise<string> {
  const fetchFn = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let pollInterval = Math.max(1, opts.interval ?? 5);
  const deadline = now() + Math.max(1, opts.expiresIn ?? 900) * 1000;
  const url = copilotOauthUrls(domain).accessToken;
  while (now() < deadline) {
    const data = await postForm(fetchFn, url, { client_id: COPILOT_CHAT_OAUTH_CLIENT_ID, device_code: deviceCode, grant_type: DEVICE_CODE_GRANT_TYPE });
    const token = data.access_token;
    if (typeof token === 'string' && token.trim()) return token.trim();
    const error = typeof data.error === 'string' ? data.error : '';
    if (error === 'authorization_pending') {
      await sleep(pollInterval * 1000);
      continue;
    }
    if (error === 'slow_down') {
      pollInterval += 5;
      await sleep(pollInterval * 1000);
      continue;
    }
    if (error === 'expired_token') throw new CliError('GitHub device authorization expired.', ExitCode.ERROR);
    if (error) throw new CliError(`GitHub device authorization failed: ${typeof data.error_description === 'string' ? data.error_description : error}`, ExitCode.ERROR);
    await sleep(pollInterval * 1000);
  }
  throw new CliError('GitHub device authorization expired.', ExitCode.ERROR);
}

/** Interactive login: prints the URL + code, waits for approval, saves the token (0600). */
export async function loginCopilot(deps: AuthDeps & { domain?: string } = {}): Promise<{ file: string; fingerprint: string; domain: string }> {
  const env = deps.env ?? process.env;
  const log = deps.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const domain = deps.domain ?? copilotGithubHost(env);
  const start = await startDeviceAuthorization(domain, deps);
  log('GitHub Copilot OAuth login');
  log(`  Open: ${start.verificationUri}`);
  log(`  Code: ${start.userCode}`);
  log('  Waiting for authorization...');
  const token = await pollDeviceAuthorization(start.deviceCode, domain, { interval: start.interval, expiresIn: start.expiresIn }, deps);
  const file = saveCopilotToken(token, domain, { ...deps, env });
  const fingerprint = tokenFingerprint(token);
  log(`  Saved: ${file}`);
  log(`  Token fingerprint: ${fingerprint}`);
  return { file, fingerprint, domain };
}

export function copilotStatus(env: NodeJS.ProcessEnv = process.env): { file: string; loggedIn: boolean; fingerprint?: string } {
  const file = copilotAuthFile(env);
  const token = readCopilotToken(env);
  return token ? { file, loggedIn: true, fingerprint: tokenFingerprint(token) } : { file, loggedIn: false };
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export type TokenConfidence = 'copilot-oauth' | 'explicit' | 'high' | 'medium' | 'generic-github';

export interface TokenCandidate {
  token: string;
  source: string;
  confidence: TokenConfidence;
}

/** Numbers > 1e10 are milliseconds; digit strings and ISO-8601 (`Z` ok) accepted. Returns seconds. */
export function parseExpiry(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw > 10_000_000_000 ? raw / 1000 : raw;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const s = raw.trim();
  if (/^\d+(\.\d+)?$/.test(s)) return parseExpiry(Number(s));
  const ms = Date.parse(s.replace(/Z$/, '+00:00'));
  return Number.isFinite(ms) ? ms / 1000 : null;
}

function entryExpired(entry: Record<string, unknown>, nowS: number): boolean {
  for (const k of EXPIRY_KEYS) {
    const exp = parseExpiry(entry[k]);
    if (exp !== null) return nowS >= exp - COPILOT_TOKEN_EXPIRY_BUFFER_S;
  }
  return false;
}

function extractOauthToken(value: unknown, nowS: number, depth = 0): string | null {
  if (!value || typeof value !== 'object' || depth > 6) return null;
  if (Array.isArray(value)) {
    for (const v of value) {
      const t = extractOauthToken(v, nowS, depth + 1);
      if (t) return t;
    }
    return null;
  }
  const obj = value as Record<string, unknown>;
  if (entryExpired(obj, nowS)) return null;
  for (const k of OAUTH_TOKEN_KEYS) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  for (const v of Object.values(obj)) {
    const t = extractOauthToken(v, nowS, depth + 1);
    if (t) return t;
  }
  return null;
}

export function copilotTokenFiles(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string[] {
  const explicit = env.GITHUB_COPILOT_TOKEN_FILE?.trim();
  if (explicit) return [path.resolve(explicit)];
  const out: string[] = [];
  const local = env.LOCALAPPDATA?.trim();
  if (local) out.push(path.join(local, 'github-copilot', 'apps.json'), path.join(local, 'github-copilot', 'hosts.json'));
  const cfg = env.XDG_CONFIG_HOME?.trim() ? path.resolve(env.XDG_CONFIG_HOME) : path.join(home, '.config');
  out.push(path.join(cfg, 'github-copilot', 'apps.json'), path.join(cfg, 'github-copilot', 'hosts.json'));
  return out;
}

function tokenFromCredentialFile(file: string, host: string, nowS: number): string | null {
  const payload = readJsonSafe<unknown>(file);
  if (!payload || typeof payload !== 'object') return null;
  const entries: Array<[string, unknown]> = Array.isArray(payload)
    ? payload.map((e, i) => {
        const key = e && typeof e === 'object' ? String((e as Record<string, unknown>).host ?? (e as Record<string, unknown>).githubHost ?? i) : String(i);
        return [key, e];
      })
    : Object.entries(payload as Record<string, unknown>);
  for (const [key, entry] of entries) {
    if (!key.toLowerCase().includes(host)) continue;
    const t = extractOauthToken(entry, nowS);
    if (t) return t;
  }
  return null;
}

function defaultExec(cmd: string, args: string[]): string | null {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Every usable OAuth token, safest source first, deduplicated by value:
 * the vg auth file → explicit Copilot env vars → credential files → generic
 * GitHub env vars → `gh auth token`.
 */
export function copilotTokenCandidates(deps: AuthDeps = {}): TokenCandidate[] {
  const env = deps.env ?? process.env;
  const home = deps.home ?? os.homedir();
  const nowS = (deps.now ?? Date.now)() / 1000;
  const exec = deps.exec === undefined ? defaultExec : deps.exec;
  const host = copilotGithubHost(env);
  const out: TokenCandidate[] = [];
  const seen = new Set<string>();
  const push = (token: string | null | undefined, source: string, confidence: TokenConfidence): void => {
    const t = token?.trim();
    if (!t || seen.has(t)) return;
    seen.add(t);
    out.push({ token: t, source, confidence });
  };
  push(readCopilotToken(env), `vg-copilot-auth:${copilotAuthFile(env)}`, 'copilot-oauth');
  for (const v of COPILOT_OAUTH_TOKEN_ENV_VARS) push(env[v], `env:${v}`, 'explicit');
  for (const file of copilotTokenFiles(env, home)) push(tokenFromCredentialFile(file, host, nowS), `file:${file}`, 'medium');
  for (const v of GENERIC_GITHUB_TOKEN_ENV_VARS) push(env[v], `env:${v}`, 'generic-github');
  if (exec !== null) {
    const gh = env.GH_PATH?.trim() || 'gh';
    const args = host === COPILOT_DEFAULT_GITHUB_HOST ? ['auth', 'token'] : ['auth', 'token', '--hostname', host];
    push(exec(gh, args), 'gh-cli', 'generic-github');
  }
  return out;
}

/** `GITHUB_COPILOT_API_TOKEN` → `COPILOT_PROVIDER_BEARER_TOKEN` → first discovery candidate. */
export function copilotToken(deps: AuthDeps = {}): TokenCandidate | null {
  const env = deps.env ?? process.env;
  for (const v of API_TOKEN_ENV_VARS) {
    const t = env[v]?.trim();
    if (t) return { token: t, source: `env:${v}`, confidence: 'explicit' };
  }
  return copilotTokenCandidates(deps)[0] ?? null;
}

// ---------------------------------------------------------------------------
// Token exchange
// ---------------------------------------------------------------------------

export interface CopilotApiToken {
  token: string;
  /** Seconds since epoch (null when the payload had none). */
  expiresAt: number | null;
  apiUrl: string;
  source: string;
  fingerprint: string;
  refreshOauthToken: string;
}

/** Client header wins → `GITHUB_COPILOT_INTEGRATION_ID` → the built-in default. */
export function copilotIntegrationId(env: NodeJS.ProcessEnv = process.env, clientHeader?: string): string {
  const c = clientHeader?.trim();
  if (c) return c;
  const e = env.GITHUB_COPILOT_INTEGRATION_ID?.trim();
  return e || COPILOT_DEFAULT_INTEGRATION_ID;
}

export function copilotExchangeHeaders(oauthToken: string, env: NodeJS.ProcessEnv = process.env, clientHeader?: string): Record<string, string> {
  return {
    Accept: 'application/json',
    Authorization: `Bearer ${oauthToken}`,
    'User-Agent': env.GITHUB_COPILOT_USER_AGENT?.trim() || COPILOT_DEFAULT_USER_AGENT,
    'Editor-Version': env.GITHUB_COPILOT_EDITOR_VERSION?.trim() || COPILOT_DEFAULT_EDITOR_VERSION,
    'Editor-Plugin-Version': env.GITHUB_COPILOT_EDITOR_PLUGIN_VERSION?.trim() || COPILOT_DEFAULT_EDITOR_PLUGIN_VERSION,
    'Copilot-Integration-Id': copilotIntegrationId(env, clientHeader),
  };
}

export async function exchangeCopilotToken(candidate: TokenCandidate, deps: AuthDeps = {}): Promise<CopilotApiToken> {
  const env = deps.env ?? process.env;
  const fetchFn = deps.fetch ?? fetch;
  const res = await fetchFn(copilotTokenExchangeUrl(env), { method: 'POST', headers: copilotExchangeHeaders(candidate.token, env) });
  if (!res.ok) throw new CliError(`Copilot token exchange failed (${res.status}); run \`vg install copilot-cli --compress --login\` to sign in again.`, ExitCode.ERROR);
  const data = (await res.json()) as Record<string, unknown>;
  const token = typeof data.token === 'string' ? data.token.trim() : '';
  if (!token) throw new CliError('Copilot token exchange returned no token.', ExitCode.ERROR);
  const endpoints = data.endpoints && typeof data.endpoints === 'object' ? (data.endpoints as Record<string, unknown>) : {};
  return {
    token,
    expiresAt: parseExpiry(data.expires_at),
    apiUrl: copilotApiHost(env, typeof endpoints.api === 'string' ? endpoints.api : undefined),
    source: `${candidate.source}:token-exchange`,
    fingerprint: tokenFingerprint(token),
    refreshOauthToken: candidate.token,
  };
}

export function copilotApiTokenValid(token: CopilotApiToken, nowMs: number): boolean {
  return token.expiresAt === null || nowMs / 1000 < token.expiresAt - COPILOT_TOKEN_EXPIRY_BUFFER_S;
}

/**
 * Resolve a bearer for the subscription lane: an explicit API token wins;
 * otherwise the first discovered OAuth token is exchanged. Null when nothing
 * is available (the caller names `vg install copilot-cli --compress --login`).
 */
export async function resolveCopilotBearer(deps: AuthDeps = {}): Promise<CopilotApiToken | null> {
  const env = deps.env ?? process.env;
  for (const v of API_TOKEN_ENV_VARS) {
    const t = env[v]?.trim();
    if (t) return { token: t, expiresAt: null, apiUrl: copilotApiHost(env), source: `env:${v}`, fingerprint: tokenFingerprint(t), refreshOauthToken: '' };
  }
  const candidates = copilotTokenCandidates(deps);
  let lastError: unknown;
  for (const c of candidates) {
    try {
      return await exchangeCopilotToken(c, deps);
    } catch (err) {
      lastError = err;
    }
  }
  if (lastError instanceof CliError) throw lastError;
  return null;
}
