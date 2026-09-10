/**
 * The agent registry for compression routing: for every supported AI coding agent, the
 * binary to launch, the environment / arguments / config edits that route it
 * through the local proxy, and how to undo them.
 *
 * Three routing styles:
 *  - `env`: the agent honours a base-URL environment variable (most CLIs);
 *  - session-local args (Codex `--config …`): nothing durable is written;
 *  - config edits (`settings-json` / `config-toml` / `config-yaml` /
 *    `config-json`): marker-tracked, backed up, reverted on exit or by
 *    `vg uninstall`. Agents whose endpoint is a GUI setting have no binary and run
 *    in watcher mode (the proxy stays up until Ctrl+C) with printed setup lines.
 *
 * The project name is passed to the proxy through `VG_PROXY_PROJECT` in the
 * child environment and, for Claude Code, an `X-Vg-Project` custom header.
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { applyJsonFields, applyManaged, applyTomlManaged, applyYamlFields, readTextSafe, revertJsonFields, revertManaged, revertTomlManaged, revertYamlFields, tomlString, type Json, type ManagedEdit, type FieldsSpec } from './edit.js';
import { copilotApiHost } from './copilot-auth.js';
import type { AgentSpec, ApplyResult, DurableScope, EditContext, LaunchContext, RevertResult, WrapAgent } from './types.js';

export const PROJECT_HEADER_NAME = 'X-Vg-Project';
export const PROJECT_ENV = 'VG_PROXY_PROJECT';

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

function truthy(v: string | undefined): boolean {
  return v !== undefined && TRUTHY.has(v.trim().toLowerCase());
}

function v1(url: string): string {
  return `${url.replace(/\/+$/, '')}/v1`;
}

/** RFC 3986-style percent-encoding of the cwd basename so it stays visible ASCII. */
export function projectNameFromCwd(cwd: string): string {
  const base = path.basename(path.resolve(cwd));
  return encodeURIComponent(base).replace(/%20/g, ' ').replace(/%28/g, '(').replace(/%29/g, ')');
}

/**
 * Append `X-Vg-Project: <name>` to `ANTHROPIC_CUSTOM_HEADERS` (newline-separated
 * `Name: value` lines). A user header of the same name, any casing, wins.
 */
export function withProjectHeader(existing: string | undefined, project: string): string {
  const lines = (existing ?? '').split(/\r?\n/).filter((l) => l.trim());
  if (lines.some((l) => l.split(':')[0]!.trim().toLowerCase() === PROJECT_HEADER_NAME.toLowerCase())) return lines.join('\n');
  return [...lines, `${PROJECT_HEADER_NAME}: ${project}`].join('\n');
}

// ---------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------

export type ClaudeBaseUrlKey = 'ANTHROPIC_BASE_URL' | 'ANTHROPIC_VERTEX_BASE_URL' | 'ANTHROPIC_FOUNDRY_BASE_URL';

/** Exactly one base-URL key applies, chosen by Claude's own provider switches. */
export function claudeBaseUrlKey(env: NodeJS.ProcessEnv): ClaudeBaseUrlKey {
  if (truthy(env.CLAUDE_CODE_USE_VERTEX)) return 'ANTHROPIC_VERTEX_BASE_URL';
  if (truthy(env.CLAUDE_CODE_USE_FOUNDRY)) return 'ANTHROPIC_FOUNDRY_BASE_URL';
  return 'ANTHROPIC_BASE_URL';
}

export function claudeProxyUrl(url: string, key: ClaudeBaseUrlKey): string {
  return key === 'ANTHROPIC_FOUNDRY_BASE_URL' ? `${url.replace(/\/+$/, '')}/anthropic` : url;
}

export const TOOL_SEARCH_ENV = 'ENABLE_TOOL_SEARCH';
export const TOOL_SEARCH_DEFAULT = 'true';
export const TOOL_SEARCH_FOUNDRY_DEFAULT = 'false';

/** Explicit non-blank value wins; else the Foundry/default value. */
export function toolSearchValue(env: NodeJS.ProcessEnv, explicit?: string): string {
  if (explicit !== undefined) return explicit;
  const cur = env[TOOL_SEARCH_ENV];
  if (cur !== undefined && cur.trim() !== '') return cur;
  return truthy(env.CLAUDE_CODE_USE_FOUNDRY) ? TOOL_SEARCH_FOUNDRY_DEFAULT : TOOL_SEARCH_DEFAULT;
}

export function claudeUserSettingsFile(home: string, env: NodeJS.ProcessEnv): string {
  const dir = env.CLAUDE_CONFIG_DIR?.trim();
  return path.join(dir ? path.resolve(dir) : path.join(home, '.claude'), 'settings.json');
}

// ---------------------------------------------------------------------------
// Editor factories
// ---------------------------------------------------------------------------

type Editor = Pick<AgentSpec, 'apply' | 'revert'>;

function withAgent(agent: WrapAgent, ctx?: EditContext): EditContext {
  return { ...(ctx ?? {}), agent };
}

function toApply(r: ReturnType<typeof applyManaged>): ApplyResult {
  return { changed: r.changed, backup: r.backup, status: r.status, fields: r.fields };
}

function toRevert(r: ReturnType<typeof revertManaged>): RevertResult {
  return { changed: r.changed, status: r.status, fields: r.fields, reason: r.reason };
}

function jsonEditor(agent: WrapAgent, fieldsFor: (url: string) => FieldsSpec): Editor {
  const edit = (file: string, url: string): ManagedEdit => ({
    format: 'json',
    edit: () => applyJsonFields(file, fieldsFor(url)),
    revert: (prev) => revertJsonFields(file, prev),
  });
  return {
    apply: (file, url, ctx) => toApply(applyManaged(file, url, edit(file, url), withAgent(agent, ctx))),
    revert: (file, ctx) => toRevert(revertManaged(file, edit(file, ''), withAgent(agent, ctx))),
  };
}

function yamlEditor(agent: WrapAgent, fieldsFor: (url: string) => FieldsSpec): Editor {
  const edit = (file: string, url: string): ManagedEdit => ({
    format: 'yaml',
    edit: () => applyYamlFields(file, fieldsFor(url)),
    revert: (prev) => revertYamlFields(file, prev),
  });
  return {
    apply: (file, url, ctx) => toApply(applyManaged(file, url, edit(file, url), withAgent(agent, ctx))),
    revert: (file, ctx) => toRevert(revertManaged(file, edit(file, ''), withAgent(agent, ctx))),
  };
}

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

export const CODEX_PROVIDER_ID = 'vg';
const CODEX_LABEL = 'vg install codex --compress';

export function codexHome(home: string, env: NodeJS.ProcessEnv): string {
  const h = env.CODEX_HOME?.trim();
  return h ? path.resolve(h) : path.join(home, '.codex');
}

/** True when Codex is signed in with ChatGPT OAuth (its `auth.json` says so). */
export function codexUsesChatGptAuth(home: string): boolean {
  const auth = readTextSafe(path.join(home, 'auth.json'));
  if (!auth) return false;
  try {
    const parsed = JSON.parse(auth) as { auth_mode?: unknown; tokens?: { account_id?: unknown } };
    if (typeof parsed.auth_mode === 'string') return parsed.auth_mode.toLowerCase() === 'chatgpt';
    return typeof parsed.tokens?.account_id === 'string' && parsed.tokens.account_id.length > 0;
  } catch {
    return false;
  }
}

/** Dotted `--config` keys: bare segments when safe, quoted otherwise (quoting a safe segment silently no-ops). */
export function codexDottedKey(...parts: string[]): string {
  return parts.map((p) => (/^[A-Za-z0-9_-]+$/.test(p) ? p : tomlString(p))).join('.');
}

function codexConfig(home: string): Json {
  const text = readTextSafe(path.join(home, 'config.toml'));
  if (!text || !text.trim()) return {};
  try {
    return parseToml(text) as Json;
  } catch {
    return {};
  }
}

/** The provider Codex will use: last `--config model_provider=…` / `-c` override → `--profile` → top-level → openai. */
export function codexActiveProvider(args: string[], config: Json): string {
  let fromArgs: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const isFlag = a === '--config' || a === '-c';
    const val = isFlag ? args[i + 1] : a.startsWith('--config=') ? a.slice('--config='.length) : undefined;
    if (val === undefined) continue;
    const m = /^model_provider\s*=\s*"?([^"]*)"?$/.exec(val.trim());
    if (m) fromArgs = m[1];
  }
  if (fromArgs) return fromArgs;
  const profileIdx = args.findIndex((a) => a === '--profile' || a === '-p');
  const profileName = profileIdx >= 0 ? args[profileIdx + 1] : args.find((a) => a.startsWith('--profile='))?.slice('--profile='.length);
  const profiles = config.profiles as Record<string, Json> | undefined;
  const fromProfile = profileName && profiles?.[profileName]?.model_provider;
  if (typeof fromProfile === 'string' && fromProfile) return fromProfile;
  return typeof config.model_provider === 'string' && config.model_provider ? config.model_provider : 'openai';
}

export function codexLaunchArgs(url: string, args: string[], ctx: LaunchContext): string[] {
  const config = codexConfig(codexHome(ctx.home, ctx.env));
  const provider = codexActiveProvider(args, config);
  const proxy = v1(url);
  if (provider === 'openai' || provider === CODEX_PROVIDER_ID) return ['--config', `openai_base_url=${tomlString(proxy)}`];
  const providers = config.model_providers as Record<string, Json> | undefined;
  const table = providers?.[provider];
  if (!table || typeof table.base_url !== 'string' || !table.base_url) {
    // Unknown custom provider: fall back to the built-in openai route so traffic still goes through the proxy.
    return ['--config', `openai_base_url=${tomlString(proxy)}`];
  }
  return ['--config', `${codexDottedKey('model_providers', provider, 'base_url')}=${tomlString(proxy)}`, '--config', `${codexDottedKey('model_providers', provider, 'supports_websockets')}=true`];
}

function codexEditor(): Editor {
  const edit = (file: string, url: string): ManagedEdit => ({
    format: 'toml',
    edit: () => {
      const home = path.dirname(file);
      const proxy = v1(url);
      const lines = [`[model_providers.${CODEX_PROVIDER_ID}]`, 'name = "OpenAI via Vibgrate AI Context"', `base_url = ${tomlString(proxy)}`, 'supports_websockets = true'];
      if (codexUsesChatGptAuth(home)) lines.push('requires_openai_auth = true');
      lines.push(`env_http_headers = { ${tomlString(PROJECT_HEADER_NAME)} = ${tomlString(PROJECT_ENV)} }`);
      return applyTomlManaged(file, {
        label: CODEX_LABEL,
        topLevel: { model_provider: tomlString(CODEX_PROVIDER_ID), openai_base_url: tomlString(proxy) },
        blocks: [lines.join('\n')],
      });
    },
    revert: (prev) => revertTomlManaged(file, CODEX_LABEL, prev),
  });
  return {
    apply: (file, url, ctx) => toApply(applyManaged(file, url, edit(file, url), withAgent('codex', ctx))),
    revert: (file, ctx) => toRevert(revertManaged(file, edit(file, ''), withAgent('codex', ctx))),
  };
}

// ---------------------------------------------------------------------------
// Copilot lanes
// ---------------------------------------------------------------------------

export const COPILOT_BYOK_ENV_VARS = [
  'COPILOT_PROVIDER_BASE_URL',
  'COPILOT_PROVIDER_TYPE',
  'COPILOT_PROVIDER_API_KEY',
  'COPILOT_PROVIDER_BEARER_TOKEN',
  'COPILOT_PROVIDER_WIRE_API',
  'COPILOT_PROVIDER_TRANSPORT',
  'COPILOT_PROVIDER_AZURE_API_VERSION',
  'COPILOT_PROVIDER_MODEL_ID',
  'COPILOT_PROVIDER_WIRE_MODEL',
  'COPILOT_PROVIDER_MODEL_LIMITS_ID',
  'COPILOT_PROVIDER_MAX_PROMPT_TOKENS',
  'COPILOT_PROVIDER_MAX_OUTPUT_TOKENS',
  'COPILOT_PROVIDER_HEADERS',
];

export type CopilotLane = 'native' | 'subscription' | 'byok';

export function copilotLane(env: NodeJS.ProcessEnv, token?: string): CopilotLane {
  if (token) return 'subscription';
  if (env.COPILOT_PROVIDER_API_KEY || env.COPILOT_PROVIDER_BEARER_TOKEN || env.COPILOT_PROVIDER_TYPE) return 'byok';
  return 'native';
}

/** `responses` for gpt-5 / o1 / o3 families, else `completions`. */
export function defaultWireApiForModel(model: string | undefined): 'completions' | 'responses' {
  const norm = (model ?? '').split(/[/:]/).pop()!.toLowerCase();
  return norm.startsWith('gpt-5') || norm.startsWith('o1') || norm.startsWith('o3') ? 'responses' : 'completions';
}

/** Copilot's BYOK API rejects `--model auto`; drop it so the native picker decides. */
export function stripAutoModelArgs(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--model' && (args[i + 1] ?? '').toLowerCase() === 'auto') {
      i++;
      continue;
    }
    if (a.toLowerCase() === '--model=auto') continue;
    out.push(a);
  }
  return out;
}

function copilotEnv(url: string, token: string | undefined, ctx?: LaunchContext): Record<string, string> {
  const env = ctx?.env ?? {};
  const lane = copilotLane(env, token);
  if (lane === 'native') return { COPILOT_API_URL: url };
  if (lane === 'subscription') {
    const wire = env.COPILOT_PROVIDER_WIRE_API === 'completions' || env.COPILOT_PROVIDER_WIRE_API === 'responses' ? env.COPILOT_PROVIDER_WIRE_API : defaultWireApiForModel(env.COPILOT_MODEL ?? env.COPILOT_PROVIDER_MODEL_ID);
    return {
      COPILOT_PROVIDER_TYPE: 'openai',
      COPILOT_PROVIDER_BASE_URL: v1(url),
      COPILOT_PROVIDER_WIRE_API: wire,
      COPILOT_PROVIDER_BEARER_TOKEN: token!,
      GITHUB_COPILOT_USE_TOKEN_EXCHANGE: 'false',
    };
  }
  const type = env.COPILOT_PROVIDER_TYPE === 'anthropic' || env.COPILOT_PROVIDER_TYPE === 'openai' ? env.COPILOT_PROVIDER_TYPE : env.ANTHROPIC_API_KEY && !env.OPENAI_API_KEY ? 'anthropic' : 'openai';
  const out: Record<string, string> = { COPILOT_PROVIDER_TYPE: type };
  const key = env.COPILOT_PROVIDER_API_KEY ?? (type === 'anthropic' ? env.ANTHROPIC_API_KEY : env.OPENAI_API_KEY);
  if (key) out.COPILOT_PROVIDER_API_KEY = key;
  if (type === 'anthropic') out.COPILOT_PROVIDER_BASE_URL = url;
  else {
    out.COPILOT_PROVIDER_BASE_URL = v1(url);
    out.COPILOT_PROVIDER_WIRE_API = env.COPILOT_PROVIDER_WIRE_API === 'responses' ? 'responses' : 'completions';
  }
  return out;
}

// ---------------------------------------------------------------------------
// OpenCode
// ---------------------------------------------------------------------------

export function opencodeConfigFile(home: string, env: NodeJS.ProcessEnv): string {
  const explicit = env.OPENCODE_CONFIG?.trim();
  if (explicit) return path.resolve(explicit);
  const dir = path.join(env.XDG_CONFIG_HOME?.trim() ? path.resolve(env.XDG_CONFIG_HOME) : path.join(home, '.config'), 'opencode');
  const jsonc = path.join(dir, 'opencode.jsonc');
  return readTextSafe(jsonc) !== null ? jsonc : path.join(dir, 'opencode.json');
}

export function opencodeConfigContent(url: string): string {
  const base = v1(url);
  return JSON.stringify({ provider: { anthropic: { options: { baseURL: base } }, openai: { options: { baseURL: base } } } });
}

// ---------------------------------------------------------------------------
// Misc config locations
// ---------------------------------------------------------------------------

function xdgConfig(home: string, env: NodeJS.ProcessEnv): string {
  return env.XDG_CONFIG_HOME?.trim() ? path.resolve(env.XDG_CONFIG_HOME) : path.join(home, '.config');
}

/** Continue's config: project `.continue/config.yaml` when present, else the user one. */
export function continueConfigFile(home: string, cwd: string): string {
  const project = path.join(cwd, '.continue', 'config.yaml');
  return readTextSafe(project) !== null ? project : path.join(home, '.continue', 'config.yaml');
}

function continueFields(url: string): FieldsSpec {
  return (current) => {
    const out: Record<string, unknown> = {};
    const models = Array.isArray(current.models) ? (current.models as unknown[]) : [];
    models.forEach((m, i) => {
      if (!m || typeof m !== 'object') return;
      const provider = String((m as Json).provider ?? '').toLowerCase();
      out[`models.${i}.apiBase`] = provider === 'anthropic' ? url : v1(url);
    });
    return out;
  };
}

function droidFields(url: string): FieldsSpec {
  return (current) => {
    const out: Record<string, unknown> = {};
    const models = Array.isArray(current.customModels) ? (current.customModels as unknown[]) : [];
    models.forEach((m, i) => {
      if (!m || typeof m !== 'object') return;
      const provider = String((m as Json).provider ?? '').toLowerCase();
      out[`customModels.${i}.base_url`] = provider === 'anthropic' ? url : v1(url);
    });
    return out;
  };
}

function baseEnv(url: string): Record<string, string> {
  return { ANTHROPIC_BASE_URL: url, OPENAI_BASE_URL: v1(url) };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/** Claude settings edit with the base-URL key chosen from the parent env. */
function claudeEditorFor(env: NodeJS.ProcessEnv): Editor {
  const key = claudeBaseUrlKey(env);
  return jsonEditor('claude', (url) => ({ [`env.${key}`]: claudeProxyUrl(url, key) }));
}

/** Revert reads the fields from the marker, so no key choice is needed. */
const claudeRevert = jsonEditor('claude', () => ({})).revert!;

export const AGENTS: Readonly<Record<WrapAgent, AgentSpec>> = {
  claude: {
    id: 'claude',
    name: 'Claude Code',
    binary: ['claude'],
    method: 'settings-json',
    env: (url, _token, ctx) => {
      const env = ctx?.env ?? {};
      const key = claudeBaseUrlKey(env);
      const out: Record<string, string> = { [key]: claudeProxyUrl(url, key), [TOOL_SEARCH_ENV]: toolSearchValue(env) };
      if (ctx) out.ANTHROPIC_CUSTOM_HEADERS = withProjectHeader(env.ANTHROPIC_CUSTOM_HEADERS, projectNameFromCwd(ctx.cwd));
      return out;
    },
    configFile: (_home, cwd) => path.join(cwd, '.claude', 'settings.local.json'),
    durableFile: (home, cwd, scope, env) => (scope === 'project' ? path.join(cwd, '.claude', 'settings.json') : claudeUserSettingsFile(home, env ?? process.env)),
    apply: (file, url, ctx) => claudeEditorFor(ctx?.env ?? process.env).apply!(file, url, ctx),
    revert: (file, ctx) => claudeRevert(file, ctx),
    install: 'npm install -g @anthropic-ai/claude-code',
    supportsUnwrap: true,
  },
  codex: {
    id: 'codex',
    name: 'Codex',
    binary: ['codex'],
    method: 'config-toml',
    env: (url) => ({ OPENAI_BASE_URL: v1(url) }),
    configFile: (home, _cwd, env) => path.join(codexHome(home, env ?? process.env), 'config.toml'),
    durableFile: (home, _cwd, _scope, env) => path.join(codexHome(home, env ?? process.env), 'config.toml'),
    launchArgs: codexLaunchArgs,
    sessionEdits: false,
    ...codexEditor(),
    install: 'npm install -g @openai/codex',
    supportsUnwrap: true,
  },
  cursor: {
    id: 'cursor',
    name: 'Cursor',
    binary: ['cursor-agent'],
    method: 'env',
    env: baseEnv,
    notes: 'Cursor IDE: Settings › Models › OpenAI API Key › Override OpenAI Base URL → <proxy>/v1 (Anthropic base: <proxy>).',
    supportsUnwrap: false,
  },
  aider: {
    id: 'aider',
    name: 'Aider',
    binary: ['aider'],
    method: 'env',
    env: (url) => ({ OPENAI_API_BASE: v1(url), ANTHROPIC_BASE_URL: url }),
    install: 'pipx install aider-chat',
    supportsUnwrap: false,
  },
  copilot: {
    id: 'copilot',
    name: 'GitHub Copilot CLI',
    binary: ['copilot'],
    method: 'env',
    env: copilotEnv,
    unsetEnv: (_url, token, ctx) => (copilotLane(ctx?.env ?? {}, token) === 'native' ? COPILOT_BYOK_ENV_VARS : ['COPILOT_PROVIDER_WIRE_API']),
    proxyEnv: (env) => ({ VG_PROXY_OPENAI_API_URL: copilotApiHost(env) }),
    install: 'npm install -g @github/copilot',
    supportsUnwrap: false,
  },
  opencode: {
    id: 'opencode',
    name: 'OpenCode',
    binary: ['opencode'],
    method: 'config-json',
    env: (url) => ({ OPENCODE_CONFIG_CONTENT: opencodeConfigContent(url) }),
    durableFile: (home, _cwd, _scope, env) => opencodeConfigFile(home, env ?? process.env),
    sessionEdits: false,
    ...jsonEditor('opencode', (url) => ({ 'provider.anthropic.options.baseURL': v1(url), 'provider.openai.options.baseURL': v1(url) })),
    supportsUnwrap: true,
  },
  cline: {
    id: 'cline',
    name: 'Cline',
    binary: [],
    method: 'env',
    env: baseEnv,
    notes: 'Cline: Settings › API Provider — Anthropic base URL <proxy>, OpenAI-compatible base URL <proxy>/v1.',
    supportsUnwrap: false,
  },
  continue: {
    id: 'continue',
    name: 'Continue',
    binary: ['cn'],
    method: 'config-yaml',
    env: baseEnv,
    configFile: continueConfigFile,
    durableFile: (home, cwd, scope) => (scope === 'project' ? path.join(cwd, '.continue', 'config.yaml') : path.join(home, '.continue', 'config.yaml')),
    ...yamlEditor('continue', continueFields),
    notes: 'Continue: every model in config.yaml gets apiBase → the proxy while wrapped.',
    supportsUnwrap: true,
  },
  goose: {
    id: 'goose',
    name: 'Goose',
    binary: ['goose'],
    method: 'config-yaml',
    env: (url) => ({ OPENAI_BASE_URL: v1(url), OPENAI_API_BASE: v1(url), ANTHROPIC_BASE_URL: url, OPENAI_HOST: url, ANTHROPIC_HOST: url }),
    durableFile: (home, _cwd, _scope, env) => path.join(xdgConfig(home, env ?? process.env), 'goose', 'config.yaml'),
    sessionEdits: false,
    ...yamlEditor('goose', (url) => ({ OPENAI_HOST: url, ANTHROPIC_HOST: url })),
    supportsUnwrap: true,
  },
  openhands: {
    id: 'openhands',
    name: 'OpenHands',
    binary: ['openhands'],
    method: 'env',
    env: (url) => ({ OPENAI_BASE_URL: v1(url), OPENAI_API_BASE: v1(url), ANTHROPIC_BASE_URL: url, LLM_BASE_URL: v1(url) }),
    supportsUnwrap: false,
  },
  vibe: {
    id: 'vibe',
    name: 'Mistral Vibe',
    binary: ['vibe'],
    method: 'env',
    env: (url) => ({
      VIBE_PROVIDERS: JSON.stringify([
        {
          name: 'mistral',
          api_base: v1(url),
          api_key_env_var: 'MISTRAL_API_KEY',
          browser_auth_base_url: 'https://console.mistral.ai',
          browser_auth_api_base_url: 'https://console.mistral.ai/api',
          backend: 'mistral',
        },
      ]),
    }),
    proxyEnv: () => ({ VG_PROXY_OPENAI_API_URL: 'https://api.mistral.ai' }),
    supportsUnwrap: false,
  },
  kimi: {
    id: 'kimi',
    name: 'Kimi Code',
    binary: ['kimi', 'kimi-cli'],
    method: 'env',
    env: (url) => ({ KIMI_CODE_BASE_URL: v1(url), KIMI_BASE_URL: v1(url) }),
    proxyEnv: () => ({ VG_PROXY_OPENAI_API_URL: 'https://api.kimi.com/coding' }),
    supportsUnwrap: false,
  },
  grok: {
    id: 'grok',
    name: 'Grok CLI',
    binary: ['grok'],
    method: 'env',
    env: (url) => ({ GROK_MODELS_BASE_URL: v1(url) }),
    proxyEnv: () => ({ VG_PROXY_OPENAI_API_URL: 'https://api.x.ai' }),
    supportsUnwrap: false,
  },
  zcode: {
    id: 'zcode',
    name: 'ZCode',
    binary: ['zcode'],
    method: 'env',
    env: baseEnv,
    notes: 'ZCode: set the enabled provider baseURL in ~/.zcode/v2/config.json to <proxy> (anthropic) or <proxy>/v1 (openai-compatible).',
    supportsUnwrap: false,
  },
  'vscode-claude': {
    id: 'vscode-claude',
    name: 'Claude Code for VS Code',
    binary: [],
    method: 'settings-json',
    env: (url) => ({ ANTHROPIC_BASE_URL: url, [TOOL_SEARCH_ENV]: 'false' }),
    configFile: (home, _cwd, env) => claudeUserSettingsFile(home, env ?? process.env),
    durableFile: (home, _cwd, _scope, env) => claudeUserSettingsFile(home, env ?? process.env),
    // The VS Code webview cannot render deferred tool blocks, so tool search is forced off here.
    ...jsonEditor('vscode-claude', (url) => ({ 'env.ANTHROPIC_BASE_URL': url, [`env.${TOOL_SEARCH_ENV}`]: 'false' })),
    notes: 'Reload the VS Code window (Developer: Reload Window) so the extension re-reads settings.json.',
    supportsUnwrap: true,
  },
  gemini: {
    id: 'gemini',
    name: 'Gemini CLI',
    binary: ['gemini'],
    method: 'env',
    env: (url) => ({ GOOGLE_GEMINI_BASE_URL: url }),
    proxyEnv: () => ({ VG_PROXY_PROVIDER: 'gemini' }),
    install: 'npm install -g @google/gemini-cli',
    supportsUnwrap: false,
  },
  qwen: {
    id: 'qwen',
    name: 'Qwen Code',
    binary: ['qwen'],
    method: 'env',
    env: (url) => ({ OPENAI_BASE_URL: v1(url) }),
    install: 'npm install -g @qwen-code/qwen-code',
    supportsUnwrap: false,
  },
  crush: {
    id: 'crush',
    name: 'Crush',
    binary: ['crush'],
    method: 'config-json',
    env: baseEnv,
    durableFile: (home, _cwd, _scope, env) => path.join(xdgConfig(home, env ?? process.env), 'crush', 'crush.json'),
    sessionEdits: false,
    ...jsonEditor('crush', (url) => ({ 'providers.openai.base_url': v1(url), 'providers.anthropic.base_url': url })),
    supportsUnwrap: true,
  },
  amp: {
    id: 'amp',
    name: 'Amp',
    binary: ['amp'],
    method: 'env',
    env: (url) => ({ AMP_URL: url }),
    proxyEnv: () => ({ VG_PROXY_UPSTREAM_BASE_URL: 'https://ampcode.com' }),
    notes: 'Amp talks to its own service; the proxy forwards to https://ampcode.com.',
    supportsUnwrap: false,
  },
  droid: {
    id: 'droid',
    name: 'Factory Droid',
    binary: ['droid'],
    method: 'config-json',
    env: baseEnv,
    durableFile: (home) => path.join(home, '.factory', 'settings.json'),
    sessionEdits: false,
    ...jsonEditor('droid', droidFields),
    supportsUnwrap: true,
  },
  kiro: {
    id: 'kiro',
    name: 'Kiro',
    binary: ['kiro-cli', 'kiro'],
    method: 'env',
    env: baseEnv,
    supportsUnwrap: false,
  },
};

export function agentSpec(id: string): AgentSpec | undefined {
  return Object.prototype.hasOwnProperty.call(AGENTS, id) ? AGENTS[id as WrapAgent] : undefined;
}

/**
 * Durable routing for `vg install --proxy`: write the proxy URL into the
 * agent's config at `scope` (marker-tracked so `vg uninstall` can undo it).
 * Agents with no config surface return `null`.
 */
export function applyProxyToAgent(
  agent: WrapAgent,
  url: string,
  opts: { scope?: DurableScope; home?: string; cwd?: string; env?: NodeJS.ProcessEnv; ctx?: EditContext } = {},
): { file: string; result: ApplyResult } | null {
  const spec = AGENTS[agent];
  if (!spec.apply || !spec.durableFile) return null;
  const env = opts.env ?? process.env;
  const home = opts.home ?? os.homedir();
  const cwd = opts.cwd ?? process.cwd();
  const file = spec.durableFile(home, cwd, opts.scope ?? 'user', env);
  return { file, result: spec.apply(file, url, { ...(opts.ctx ?? {}), env, agent, durable: true }) };
}
