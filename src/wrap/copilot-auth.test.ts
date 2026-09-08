import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  copilotApiHost,
  copilotAuthFile,
  copilotEnterpriseDomain,
  copilotExchangeHeaders,
  copilotGithubHost,
  copilotIntegrationId,
  copilotOauthUrls,
  copilotStatus,
  copilotToken,
  copilotTokenCandidates,
  copilotTokenExchangeUrl,
  copilotUserInfoUrl,
  exchangeCopilotToken,
  copilotApiTokenValid,
  isCopilotApiUrl,
  loginCopilot,
  parseExpiry,
  pollDeviceAuthorization,
  readCopilotToken,
  resolveCopilotBearer,
  saveCopilotToken,
  startDeviceAuthorization,
  tokenFingerprint,
  COPILOT_CHAT_OAUTH_CLIENT_ID,
} from './copilot-auth.js';

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'vg-copilot-'));

type Handler = (url: string, init: RequestInit) => unknown;
function fakeFetch(handler: Handler): { fetch: typeof fetch; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const f = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    const out = handler(url, init);
    const body = out instanceof Response ? out : new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
    return body;
  }) as typeof fetch;
  return { fetch: f, calls };
}

describe('device flow', () => {
  it('start posts the client id + scope as a form with the Copilot headers', async () => {
    const { fetch, calls } = fakeFetch(() => ({ verification_uri: 'https://github.com/login/device', user_code: 'X', device_code: 'D', interval: 7, expires_in: 100 }));
    const s = await startDeviceAuthorization('github.com', { fetch });
    expect(s).toEqual({ verificationUri: 'https://github.com/login/device', userCode: 'X', deviceCode: 'D', interval: 7, expiresIn: 100 });
    expect(calls[0]!.url).toBe('https://github.com/login/device/code');
    expect(calls[0]!.init.method).toBe('POST');
    expect(calls[0]!.init.body).toBe(`client_id=${encodeURIComponent(COPILOT_CHAT_OAUTH_CLIENT_ID)}&scope=read%3Auser`);
    expect(calls[0]!.init.headers).toEqual({ Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'GitHubCopilotChat/0.35.0' });
  });

  it('start rejects incomplete or non-object responses', async () => {
    await expect(startDeviceAuthorization('github.com', { fetch: fakeFetch(() => ({ user_code: 'X' })).fetch })).rejects.toThrow(/incomplete response/);
    await expect(startDeviceAuthorization('github.com', { fetch: fakeFetch(() => [1]).fetch })).rejects.toThrow(/invalid response/);
  });

  it('poll: pending → slow_down (+5 s) → success, honouring the grant type and sleeping between polls', async () => {
    const responses = [{ error: 'authorization_pending' }, { error: 'slow_down' }, {}, { access_token: '  gho_abc  ' }];
    const { fetch, calls } = fakeFetch(() => responses.shift());
    const sleeps: number[] = [];
    let t = 0;
    const token = await pollDeviceAuthorization('D', 'github.com', { interval: 5, expires_in: 900 } as never, { fetch, now: () => t, sleep: async (ms) => void (sleeps.push(ms), (t += ms)) });
    expect(token).toBe('gho_abc');
    expect(sleeps).toEqual([5000, 10000, 10000]);
    expect(calls[0]!.init.body).toBe(`client_id=${encodeURIComponent(COPILOT_CHAT_OAUTH_CLIENT_ID)}&device_code=D&grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:device_code')}`);
    expect(calls[0]!.url).toBe('https://github.com/login/oauth/access_token');
  });

  it('poll: expired_token, other errors, and the deadline', async () => {
    await expect(pollDeviceAuthorization('D', 'github.com', {}, { fetch: fakeFetch(() => ({ error: 'expired_token' })).fetch })).rejects.toThrow('GitHub device authorization expired.');
    await expect(pollDeviceAuthorization('D', 'github.com', {}, { fetch: fakeFetch(() => ({ error: 'access_denied', error_description: 'nope' })).fetch })).rejects.toThrow('GitHub device authorization failed: nope');
    let t = 0;
    await expect(pollDeviceAuthorization('D', 'github.com', { interval: 1, expiresIn: 2 }, { fetch: fakeFetch(() => ({ error: 'authorization_pending' })).fetch, now: () => t, sleep: async (ms) => void (t += ms) })).rejects.toThrow('expired');
  });

  it('login saves a 0600 token file with the documented shape and never logs the token', async () => {
    const dir = tmp();
    const env = { VG_CONTEXT_DIR: dir };
    const lines: string[] = [];
    const responses = [{ verification_uri: 'https://github.com/login/device', user_code: 'CODE', device_code: 'D', interval: 1, expires_in: 60 }, { access_token: 'gho_secret' }];
    const r = await loginCopilot({ env, fetch: fakeFetch(() => responses.shift()).fetch, now: () => 1_712_345_678_900, sleep: async () => undefined, log: (l) => lines.push(l) });
    expect(r.file).toBe(path.join(dir, 'copilot_auth.json'));
    expect(fs.statSync(r.file).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(r.file, 'utf8')).toBe(`${JSON.stringify({ created_at: 1712345678, domain: 'github.com', provider: 'github-copilot', refresh: 'gho_secret', type: 'oauth' }, null, 2)}\n`);
    expect(r.fingerprint).toBe(tokenFingerprint('gho_secret'));
    expect(r.fingerprint).toMatch(/^sha256:[0-9a-f]{12}$/);
    expect(lines).toEqual(['GitHub Copilot OAuth login', '  Open: https://github.com/login/device', '  Code: CODE', '  Waiting for authorization...', `  Saved: ${r.file}`, `  Token fingerprint: ${r.fingerprint}`]);
    expect(lines.join('\n')).not.toContain('gho_secret');
    expect(readCopilotToken(env)).toBe('gho_secret');
    expect(copilotStatus(env)).toEqual({ file: r.file, loggedIn: true, fingerprint: r.fingerprint });
  });

  it('token file: explicit VG_COPILOT_AUTH_FILE, only `type: oauth` counts, empty refused', () => {
    const dir = tmp();
    const file = path.join(dir, 'nested', 'auth.json');
    const env = { VG_COPILOT_AUTH_FILE: file };
    expect(copilotAuthFile(env)).toBe(file);
    expect(() => saveCopilotToken('  ', 'github.com', { env })).toThrow(/empty/);
    saveCopilotToken('t', 'https://ghe.example.com/', { env, now: () => 0 });
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).domain).toBe('ghe.example.com');
    fs.writeFileSync(file, JSON.stringify({ type: 'pat', refresh: 'x' }));
    expect(readCopilotToken(env)).toBeNull();
    expect(copilotStatus(env).loggedIn).toBe(false);
    fs.writeFileSync(file, 'not json');
    expect(readCopilotToken(env)).toBeNull();
  });
});

describe('hosts and policy', () => {
  it('github host resolution and OAuth / exchange URLs', () => {
    expect(copilotGithubHost({})).toBe('github.com');
    expect(copilotGithubHost({ GITHUB_COPILOT_HOST: 'GHE.corp' })).toBe('ghe.corp');
    expect(copilotEnterpriseDomain({ GITHUB_COPILOT_ENTERPRISE_URL: 'https://ghe.corp/' })).toBe('ghe.corp');
    expect(copilotGithubHost({ GITHUB_COPILOT_ENTERPRISE_DOMAIN: 'ghe.corp' })).toBe('ghe.corp');
    expect(copilotGithubHost({ GITHUB_COPILOT_API_URL: 'https://copilot-api.ghe.corp' })).toBe('ghe.corp');
    expect(copilotGithubHost({ GITHUB_COPILOT_API_URL: 'https://api.business.githubcopilot.com' })).toBe('github.com');
    expect(copilotOauthUrls('ghe.corp')).toEqual({ deviceCode: 'https://ghe.corp/login/device/code', accessToken: 'https://ghe.corp/login/oauth/access_token' });
    expect(copilotOauthUrls('bad host!')).toEqual({ deviceCode: 'https://github.com/login/device/code', accessToken: 'https://github.com/login/oauth/access_token' });
    expect(copilotTokenExchangeUrl({})).toBe('https://api.github.com/copilot_internal/v2/token');
    expect(copilotTokenExchangeUrl({ GITHUB_COPILOT_ENTERPRISE_URL: 'ghe.corp' })).toBe('https://api.ghe.corp/copilot_internal/v2/token');
    expect(copilotTokenExchangeUrl({ GITHUB_COPILOT_TOKEN_EXCHANGE_URL: 'https://x/t' })).toBe('https://x/t');
    expect(copilotUserInfoUrl({ GITHUB_COPILOT_ENTERPRISE_URL: 'ghe.corp' })).toBe('https://api.ghe.corp/copilot_internal/user');
    expect(copilotUserInfoUrl({ GITHUB_COPILOT_USER_INFO_URL: 'https://x/u' })).toBe('https://x/u');
  });

  it('API host policy: explicit override wins; segmented hosts collapse; tenants kept; others → default', () => {
    expect(copilotApiHost({ GITHUB_COPILOT_API_URL: 'https://copilot-api.ghe.corp/' }, 'https://api.githubcopilot.com')).toBe('https://copilot-api.ghe.corp');
    expect(copilotApiHost({})).toBe('https://api.githubcopilot.com');
    expect(copilotApiHost({}, 'https://api.business.githubcopilot.com')).toBe('https://api.githubcopilot.com');
    expect(copilotApiHost({}, 'https://api.individual.githubcopilot.com')).toBe('https://api.githubcopilot.com');
    expect(copilotApiHost({}, 'https://api.enterprise.githubcopilot.com')).toBe('https://api.githubcopilot.com');
    expect(copilotApiHost({}, 'https://api.eu.githubcopilot.com/x')).toBe('https://api.eu.githubcopilot.com');
    expect(copilotApiHost({}, 'https://evil.example.com')).toBe('https://api.githubcopilot.com');
    expect(copilotApiHost({}, 'not a url')).toBe('https://api.githubcopilot.com');
    expect(isCopilotApiUrl('https://api.githubcopilot.com')).toBe(true);
    expect(isCopilotApiUrl('https://copilot-proxy.githubusercontent.com')).toBe(false);
  });

  it('exchange headers: integration id precedence; env overrides for versions', () => {
    expect(copilotIntegrationId({})).toBe('vscode-chat');
    expect(copilotIntegrationId({ GITHUB_COPILOT_INTEGRATION_ID: 'copilot-cli' })).toBe('copilot-cli');
    expect(copilotIntegrationId({ GITHUB_COPILOT_INTEGRATION_ID: 'copilot-cli' }, 'client-id')).toBe('client-id');
    expect(copilotExchangeHeaders('tok', { GITHUB_COPILOT_EDITOR_VERSION: 'vscode/2' })).toEqual({
      Accept: 'application/json',
      Authorization: 'Bearer tok',
      'User-Agent': 'GitHubCopilotChat/0.35.0',
      'Editor-Version': 'vscode/2',
      'Editor-Plugin-Version': 'copilot-chat/0.35.0',
      'Copilot-Integration-Id': 'vscode-chat',
    });
  });

  it('parseExpiry: seconds, milliseconds, digit strings, ISO with Z; validity uses the 60 s buffer', () => {
    expect(parseExpiry(1_700_000_000)).toBe(1_700_000_000);
    expect(parseExpiry(1_700_000_000_000)).toBe(1_700_000_000);
    expect(parseExpiry('1700000000')).toBe(1_700_000_000);
    expect(parseExpiry('2024-01-01T00:00:00Z')).toBe(1_704_067_200);
    expect(parseExpiry('soon')).toBeNull();
    expect(parseExpiry(null)).toBeNull();
    const tok = { token: 't', expiresAt: 1000, apiUrl: 'u', source: 's', fingerprint: 'f', refreshOauthToken: 'r' };
    expect(copilotApiTokenValid(tok, 939_000)).toBe(true);
    expect(copilotApiTokenValid(tok, 940_000)).toBe(false);
    expect(copilotApiTokenValid({ ...tok, expiresAt: null }, 1e15)).toBe(true);
  });
});

describe('discovery and exchange', () => {
  it('candidates: auth file → explicit env → credential files (host-matched, expiry-aware) → generic env → gh; deduped', () => {
    const dir = tmp();
    const cfg = path.join(dir, 'cfg');
    fs.mkdirSync(path.join(cfg, 'github-copilot'), { recursive: true });
    fs.writeFileSync(
      path.join(cfg, 'github-copilot', 'hosts.json'),
      JSON.stringify({ 'github.com:Iv1.xyz': { user: 'me', oauth_token: 'gho_fromfile' }, 'ghe.corp': { oauth_token: 'gho_other' }, 'github.com:old': { oauth_token: 'gho_expired', expires_at: 1 } }),
    );
    fs.writeFileSync(path.join(cfg, 'github-copilot', 'apps.json'), JSON.stringify([{ host: 'github.com', tokens: { accessToken: 'gho_fromapps', expiresAt: 4_000_000_000_000 } }]));
    const env = { VG_CONTEXT_DIR: dir, XDG_CONFIG_HOME: cfg, GITHUB_COPILOT_TOKEN: 'gho_explicit', GH_TOKEN: 'gho_generic', GITHUB_TOKEN: 'gho_explicit' };
    saveCopilotToken('gho_saved', 'github.com', { env });
    const cands = copilotTokenCandidates({ env, home: dir, now: () => 1_700_000_000_000, exec: (cmd, args) => (cmd === 'gh' && args.join(' ') === 'auth token' ? 'gho_gh' : null) });
    expect(cands.map((c) => [c.token, c.confidence])).toEqual([
      ['gho_saved', 'copilot-oauth'],
      ['gho_explicit', 'explicit'],
      ['gho_fromapps', 'medium'],
      ['gho_fromfile', 'medium'],
      ['gho_generic', 'generic-github'],
      ['gho_gh', 'generic-github'],
    ]);
    expect(cands[0]!.source).toBe(`vg-copilot-auth:${path.join(dir, 'copilot_auth.json')}`);
    expect(cands[1]!.source).toBe('env:GITHUB_COPILOT_TOKEN');
    expect(copilotToken({ env, home: dir, exec: () => null })!.token).toBe('gho_saved');
    expect(copilotToken({ env: { ...env, GITHUB_COPILOT_API_TOKEN: 'api' }, home: dir, exec: () => null })).toEqual({ token: 'api', source: 'env:GITHUB_COPILOT_API_TOKEN', confidence: 'explicit' });
    expect(copilotTokenCandidates({ env: { GITHUB_COPILOT_TOKEN_FILE: path.join(cfg, 'github-copilot', 'apps.json'), VG_CONTEXT_DIR: tmp() }, home: dir, now: () => 1_700_000_000_000, exec: () => null }).map((c) => c.token)).toEqual(['gho_fromapps']);
  });

  it('exchange: posts the OAuth bearer, parses token/expiry/endpoints under the host policy; failures are actionable', async () => {
    const { fetch, calls } = fakeFetch(() => ({ token: 'tid=1', expires_at: 1_700_000_000, endpoints: { api: 'https://api.individual.githubcopilot.com' } }));
    const r = await exchangeCopilotToken({ token: 'gho', source: 'env:X', confidence: 'explicit' }, { fetch, env: {} });
    expect(r).toEqual({ token: 'tid=1', expiresAt: 1_700_000_000, apiUrl: 'https://api.githubcopilot.com', source: 'env:X:token-exchange', fingerprint: tokenFingerprint('tid=1'), refreshOauthToken: 'gho' });
    expect(calls[0]!.url).toBe('https://api.github.com/copilot_internal/v2/token');
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer gho');
    await expect(exchangeCopilotToken({ token: 'gho', source: 's', confidence: 'explicit' }, { fetch: fakeFetch(() => new Response('{}', { status: 401 })).fetch, env: {} })).rejects.toThrow(/exchange failed \(401\).*--login/);
    await expect(exchangeCopilotToken({ token: 'gho', source: 's', confidence: 'explicit' }, { fetch: fakeFetch(() => ({})).fetch, env: {} })).rejects.toThrow(/no token/);
  });

  it('resolveCopilotBearer: explicit API token short-circuits; otherwise exchanges; null when nothing is available', async () => {
    const dir = tmp();
    expect(await resolveCopilotBearer({ env: { GITHUB_COPILOT_API_TOKEN: 'api', VG_CONTEXT_DIR: dir }, home: dir, exec: () => null })).toMatchObject({ token: 'api', source: 'env:GITHUB_COPILOT_API_TOKEN' });
    expect(await resolveCopilotBearer({ env: { VG_CONTEXT_DIR: dir }, home: dir, exec: () => null })).toBeNull();
    const { fetch } = fakeFetch(() => ({ token: 'ex', expires_at: 4e9 }));
    expect(await resolveCopilotBearer({ env: { VG_CONTEXT_DIR: dir, GITHUB_COPILOT_TOKEN: 'gho' }, home: dir, fetch, exec: () => null })).toMatchObject({ token: 'ex', source: 'env:GITHUB_COPILOT_TOKEN:token-exchange' });
    // An expired refresh token surfaces the exchange failure rather than silently returning null.
    await expect(resolveCopilotBearer({ env: { VG_CONTEXT_DIR: dir, GITHUB_COPILOT_TOKEN: 'stale' }, home: dir, fetch: fakeFetch(() => new Response('', { status: 401 })).fetch, exec: () => null })).rejects.toThrow(/--login/);
  });
});
