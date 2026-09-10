import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  AGENTS,
  applyProxyToAgent,
  claudeBaseUrlKey,
  claudeProxyUrl,
  codexActiveProvider,
  codexDottedKey,
  codexLaunchArgs,
  codexUsesChatGptAuth,
  copilotLane,
  defaultWireApiForModel,
  opencodeConfigContent,
  projectNameFromCwd,
  stripAutoModelArgs,
  toolSearchValue,
  withProjectHeader,
  COPILOT_BYOK_ENV_VARS,
} from './agents.js';
import { WRAP_AGENTS, type WrapAgent } from './types.js';
import { readMarker } from './edit.js';
import { wrapBackupPath } from '../compress/paths.js';

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'vg-wrap-agents-'));
const URL = 'http://127.0.0.1:8787';

describe('AGENTS registry', () => {
  it('covers every WrapAgent with a consistent spec', () => {
    for (const id of WRAP_AGENTS) {
      const spec = AGENTS[id];
      expect(spec.id).toBe(id);
      expect(spec.name.length).toBeGreaterThan(0);
      expect(Array.isArray(spec.binary)).toBe(true);
      if (spec.binary.length === 0) expect(spec.notes, `${id} has no binary and must print setup notes`).toBeTruthy();
      if (spec.supportsUnwrap) expect(spec.apply && spec.revert, `${id} supportsUnwrap needs apply/revert`).toBeTruthy();
      const env = spec.env(URL, undefined, { home: '/h', cwd: '/w/proj', env: {} });
      for (const [k, v] of Object.entries(env)) {
        expect(k).toMatch(/^[A-Z0-9_]+$/);
        expect(typeof v).toBe('string');
      }
      // Every value is derived from the proxy URL or a fixed constant — no host paths, no secrets.
      expect(JSON.stringify(env)).not.toContain('/h/');
    }
  });

  it('env maps use the exact upstream variable names', () => {
    const ctx = { home: '/h', cwd: '/w/my proj', env: {} };
    expect(AGENTS.claude.env(URL, undefined, ctx)).toEqual({ ANTHROPIC_BASE_URL: URL, ENABLE_TOOL_SEARCH: 'true', ANTHROPIC_CUSTOM_HEADERS: 'X-Vg-Project: my proj' });
    expect(AGENTS.codex.env(URL)).toEqual({ OPENAI_BASE_URL: `${URL}/v1` });
    expect(AGENTS.aider.env(URL)).toEqual({ OPENAI_API_BASE: `${URL}/v1`, ANTHROPIC_BASE_URL: URL });
    expect(AGENTS.goose.env(URL)).toMatchObject({ OPENAI_BASE_URL: `${URL}/v1`, OPENAI_API_BASE: `${URL}/v1`, ANTHROPIC_BASE_URL: URL });
    expect(AGENTS.openhands.env(URL)).toMatchObject({ LLM_BASE_URL: `${URL}/v1`, OPENAI_BASE_URL: `${URL}/v1`, ANTHROPIC_BASE_URL: URL });
    expect(AGENTS.kimi.env(URL)).toEqual({ KIMI_CODE_BASE_URL: `${URL}/v1`, KIMI_BASE_URL: `${URL}/v1` });
    expect(AGENTS.grok.env(URL)).toEqual({ GROK_MODELS_BASE_URL: `${URL}/v1` });
    expect(AGENTS.gemini.env(URL)).toEqual({ GOOGLE_GEMINI_BASE_URL: URL });
    expect(AGENTS.qwen.env(URL)).toEqual({ OPENAI_BASE_URL: `${URL}/v1` });
    expect(AGENTS['vscode-claude'].env(URL)).toEqual({ ANTHROPIC_BASE_URL: URL, ENABLE_TOOL_SEARCH: 'false' });
    const vibe = JSON.parse(AGENTS.vibe.env(URL).VIBE_PROVIDERS!) as Array<Record<string, string>>;
    expect(vibe).toEqual([{ name: 'mistral', api_base: `${URL}/v1`, api_key_env_var: 'MISTRAL_API_KEY', browser_auth_base_url: 'https://console.mistral.ai', browser_auth_api_base_url: 'https://console.mistral.ai/api', backend: 'mistral' }]);
    expect(JSON.parse(AGENTS.opencode.env(URL).OPENCODE_CONFIG_CONTENT!)).toEqual({ provider: { anthropic: { options: { baseURL: `${URL}/v1` } }, openai: { options: { baseURL: `${URL}/v1` } } } });
    expect(opencodeConfigContent(URL)).not.toContain(' ');
    expect(AGENTS.grok.proxyEnv!({})).toEqual({ VG_PROXY_OPENAI_API_URL: 'https://api.x.ai' });
    expect(AGENTS.vibe.proxyEnv!({})).toEqual({ VG_PROXY_OPENAI_API_URL: 'https://api.mistral.ai' });
  });

  it('Claude: exactly one base-URL key, chosen by Vertex/Foundry switches; tool search precedence', () => {
    expect(claudeBaseUrlKey({})).toBe('ANTHROPIC_BASE_URL');
    expect(claudeBaseUrlKey({ CLAUDE_CODE_USE_VERTEX: '1' })).toBe('ANTHROPIC_VERTEX_BASE_URL');
    expect(claudeBaseUrlKey({ CLAUDE_CODE_USE_FOUNDRY: 'true' })).toBe('ANTHROPIC_FOUNDRY_BASE_URL');
    expect(claudeProxyUrl(URL, 'ANTHROPIC_FOUNDRY_BASE_URL')).toBe(`${URL}/anthropic`);
    expect(claudeProxyUrl(URL, 'ANTHROPIC_VERTEX_BASE_URL')).toBe(URL);
    const vertex = AGENTS.claude.env(URL, undefined, { home: '/h', cwd: '/w', env: { CLAUDE_CODE_USE_VERTEX: '1' } });
    expect(Object.keys(vertex).filter((k) => k.endsWith('BASE_URL'))).toEqual(['ANTHROPIC_VERTEX_BASE_URL']);
    expect(toolSearchValue({})).toBe('true');
    expect(toolSearchValue({ CLAUDE_CODE_USE_FOUNDRY: '1' })).toBe('false');
    expect(toolSearchValue({ ENABLE_TOOL_SEARCH: 'auto:50' })).toBe('auto:50');
    expect(toolSearchValue({ ENABLE_TOOL_SEARCH: '   ' })).toBe('true');
    expect(toolSearchValue({ ENABLE_TOOL_SEARCH: 'false' }, 'auto')).toBe('auto');
  });

  it('project attribution: percent-encoded basename; a user header of the same name wins', () => {
    expect(projectNameFromCwd('/x/my proj (v2)')).toBe('my proj (v2)');
    expect(projectNameFromCwd('/x/äpp')).toBe('%C3%A4pp');
    expect(withProjectHeader(undefined, 'p')).toBe('X-Vg-Project: p');
    expect(withProjectHeader('X-Other: 1\n', 'p')).toBe('X-Other: 1\nX-Vg-Project: p');
    expect(withProjectHeader('x-vg-project: mine', 'p')).toBe('x-vg-project: mine');
  });

  it('Codex: active provider resolution, bare dotted keys, launch args', () => {
    expect(codexDottedKey('model_providers', 'my-prov', 'base_url')).toBe('model_providers.my-prov.base_url');
    expect(codexDottedKey('model_providers', 'my prov', 'base_url')).toBe('model_providers."my prov".base_url');
    expect(codexActiveProvider([], {})).toBe('openai');
    expect(codexActiveProvider([], { model_provider: 'azure' })).toBe('azure');
    expect(codexActiveProvider(['--profile', 'fast'], { model_provider: 'azure', profiles: { fast: { model_provider: 'fastprov' } } })).toBe('fastprov');
    expect(codexActiveProvider(['-c', 'model_provider="cli"', '--profile', 'fast'], { profiles: { fast: { model_provider: 'fastprov' } } })).toBe('cli');
    const home = tmp();
    const env = { CODEX_HOME: home };
    expect(codexLaunchArgs(URL, [], { home, cwd: home, env })).toEqual(['--config', `openai_base_url="${URL}/v1"`]);
    fs.writeFileSync(path.join(home, 'config.toml'), 'model_provider = "gw"\n[model_providers.gw]\nbase_url = "https://gw.example/v1"\n');
    expect(codexLaunchArgs(URL, [], { home, cwd: home, env })).toEqual(['--config', `model_providers.gw.base_url="${URL}/v1"`, '--config', 'model_providers.gw.supports_websockets=true']);
    fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt' }));
    expect(codexUsesChatGptAuth(home)).toBe(true);
    fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ tokens: { account_id: 'acc' } }));
    expect(codexUsesChatGptAuth(home)).toBe(true);
    fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'sk' }));
    expect(codexUsesChatGptAuth(home)).toBe(false);
  });

  it('Copilot: three lanes, BYOK vars popped only in the native lane, wire-api defaults, --model auto stripped', () => {
    expect(copilotLane({})).toBe('native');
    expect(copilotLane({ COPILOT_PROVIDER_API_KEY: 'k' })).toBe('byok');
    expect(copilotLane({}, 'tok')).toBe('subscription');
    const native = AGENTS.copilot.env(URL, undefined, { home: '/h', cwd: '/w', env: {} });
    expect(native).toEqual({ COPILOT_API_URL: URL });
    expect(AGENTS.copilot.unsetEnv!(URL, undefined, { home: '/h', cwd: '/w', env: {} })).toEqual(COPILOT_BYOK_ENV_VARS);
    const sub = AGENTS.copilot.env(URL, 'tok', { home: '/h', cwd: '/w', env: { COPILOT_MODEL: 'gpt-5' } });
    expect(sub).toEqual({ COPILOT_PROVIDER_TYPE: 'openai', COPILOT_PROVIDER_BASE_URL: `${URL}/v1`, COPILOT_PROVIDER_WIRE_API: 'responses', COPILOT_PROVIDER_BEARER_TOKEN: 'tok', GITHUB_COPILOT_USE_TOKEN_EXCHANGE: 'false' });
    const byok = AGENTS.copilot.env(URL, undefined, { home: '/h', cwd: '/w', env: { COPILOT_PROVIDER_TYPE: 'anthropic', ANTHROPIC_API_KEY: 'ak' } });
    expect(byok).toEqual({ COPILOT_PROVIDER_TYPE: 'anthropic', COPILOT_PROVIDER_API_KEY: 'ak', COPILOT_PROVIDER_BASE_URL: URL });
    expect(AGENTS.copilot.unsetEnv!(URL, undefined, { home: '/h', cwd: '/w', env: { COPILOT_PROVIDER_TYPE: 'anthropic' } })).toEqual(['COPILOT_PROVIDER_WIRE_API']);
    expect(defaultWireApiForModel('openai/gpt-5-mini')).toBe('responses');
    expect(defaultWireApiForModel('o3')).toBe('responses');
    expect(defaultWireApiForModel('gpt-4.1')).toBe('completions');
    expect(defaultWireApiForModel(undefined)).toBe('completions');
    expect(stripAutoModelArgs(['--model', 'auto', '-p', 'hi', '--model=AUTO', '--model', 'gpt-5'])).toEqual(['-p', 'hi', '--model', 'gpt-5']);
  });
});

describe('applyProxyToAgent (durable) round-trips every config-editing agent', () => {
  const cases: Array<{ agent: WrapAgent; seed: (home: string, cwd: string, env: NodeJS.ProcessEnv) => string; check: (text: string) => void }> = [
    {
      agent: 'claude',
      seed: (home) => {
        const f = path.join(home, '.claude', 'settings.json');
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, '{\n  "permissions": { "allow": ["Bash(ls)"] },\n  "env": { "FOO": "1" }\n}\n');
        return f;
      },
      check: (t) => {
        const j = JSON.parse(t) as { env: Record<string, string>; permissions: unknown };
        expect(j.env.ANTHROPIC_BASE_URL).toBe(URL);
        expect(j.env.FOO).toBe('1');
        expect(j.permissions).toEqual({ allow: ['Bash(ls)'] });
      },
    },
    {
      agent: 'codex',
      seed: (home) => {
        const f = path.join(home, '.codex', 'config.toml');
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, '# my codex\nmodel = "gpt-5"\n\n[mcp_servers.vg]\ncommand = "vg"\nargs = ["serve"]\n');
        return f;
      },
      check: (t) => {
        expect(t).toContain('model_provider = "vg"');
        expect(t).toContain(`openai_base_url = "${URL}/v1"`);
        expect(t).toContain('[model_providers.vg]');
        expect(t).toContain('env_http_headers = { "X-Vg-Project" = "VG_PROXY_PROJECT" }');
        expect(t).not.toContain('requires_openai_auth');
        expect(t).toContain('# my codex');
        expect(t).toContain('[mcp_servers.vg]');
        expect(t.indexOf('model_provider = "vg"')).toBeLessThan(t.indexOf('[mcp_servers.vg]'));
      },
    },
    {
      agent: 'opencode',
      seed: (home) => {
        const f = path.join(home, '.config', 'opencode', 'opencode.jsonc');
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, '{\n  // my opencode\n  "theme": "dark",\n  "provider": { "openai": { "options": { "baseURL": "https://gw/v1" } } },\n}\n');
        return f;
      },
      check: (t) => {
        const j = JSON.parse(t) as { theme: string; provider: Record<string, { options: { baseURL: string } }> };
        expect(j.theme).toBe('dark');
        expect(j.provider.openai!.options.baseURL).toBe(`${URL}/v1`);
        expect(j.provider.anthropic!.options.baseURL).toBe(`${URL}/v1`);
      },
    },
    {
      agent: 'continue',
      seed: (home) => {
        const f = path.join(home, '.continue', 'config.yaml');
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, '# continue\nname: mine\nmodels:\n  - name: c\n    provider: anthropic\n    model: claude\n  - name: o\n    provider: openai\n    apiBase: https://gw/v1\n');
        return f;
      },
      check: (t) => {
        expect(t).toContain('# continue');
        expect(t).toContain(`apiBase: ${URL}\n`);
        expect(t).toContain(`apiBase: ${URL}/v1\n`);
      },
    },
    {
      agent: 'goose',
      seed: (home) => {
        const f = path.join(home, '.config', 'goose', 'config.yaml');
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, 'GOOSE_PROVIDER: openai\nOPENAI_HOST: https://api.openai.com # default\n');
        return f;
      },
      check: (t) => {
        expect(t).toContain(`OPENAI_HOST: ${URL}`);
        expect(t).toContain(`ANTHROPIC_HOST: ${URL}`);
        expect(t).toContain('GOOSE_PROVIDER: openai');
      },
    },
    {
      agent: 'crush',
      seed: (home) => {
        const f = path.join(home, '.config', 'crush', 'crush.json');
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, '{"providers":{"openai":{"api_key":"k","base_url":"https://api.openai.com/v1"}}}\n');
        return f;
      },
      check: (t) => {
        const j = JSON.parse(t) as { providers: Record<string, Record<string, string>> };
        expect(j.providers.openai!.base_url).toBe(`${URL}/v1`);
        expect(j.providers.openai!.api_key).toBe('k');
        expect(j.providers.anthropic!.base_url).toBe(URL);
      },
    },
    {
      agent: 'droid',
      seed: (home) => {
        const f = path.join(home, '.factory', 'settings.json');
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, '{"customModels":[{"model":"claude","provider":"anthropic","base_url":"https://api.anthropic.com","api_key":"k"},{"model":"gpt","provider":"openai","base_url":"https://api.openai.com/v1"}]}\n');
        return f;
      },
      check: (t) => {
        const j = JSON.parse(t) as { customModels: Array<Record<string, string>> };
        expect(j.customModels[0]!.base_url).toBe(URL);
        expect(j.customModels[0]!.api_key).toBe('k');
        expect(j.customModels[1]!.base_url).toBe(`${URL}/v1`);
      },
    },
    {
      agent: 'vscode-claude',
      seed: (home, _cwd, env) => {
        const f = path.join(env.CLAUDE_CONFIG_DIR ?? path.join(home, '.claude'), 'settings.json');
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, '{"env":{"ENABLE_TOOL_SEARCH":"auto:50"}}\n');
        return f;
      },
      check: (t) => {
        const j = JSON.parse(t) as { env: Record<string, string> };
        expect(j.env).toEqual({ ENABLE_TOOL_SEARCH: 'false', ANTHROPIC_BASE_URL: URL });
      },
    },
  ];

  for (const tc of cases) {
    it(`${tc.agent}: apply writes the routing, revert is byte-identical`, () => {
      const home = tmp();
      const cwd = path.join(home, 'proj');
      fs.mkdirSync(cwd);
      const env: NodeJS.ProcessEnv = { HOME: home, XDG_CONFIG_HOME: path.join(home, '.config') };
      if (tc.agent === 'vscode-claude') env.CLAUDE_CONFIG_DIR = path.join(home, 'cc');
      const file = tc.seed(home, cwd, env);
      const original = fs.readFileSync(file, 'utf8');
      const ctx = { agent: tc.agent, now: () => 1, version: 't', isAlive: () => false };
      const r = applyProxyToAgent(tc.agent, URL, { home, cwd, env, ctx });
      expect(r).not.toBeNull();
      expect(r!.file).toBe(file);
      expect(r!.result.status).toBe('applied');
      expect(fs.existsSync(wrapBackupPath(file))).toBe(true);
      tc.check(fs.readFileSync(file, 'utf8'));
      expect(readMarker(file)?.durable).toBe(true);
      // Applying twice is idempotent.
      const again = applyProxyToAgent(tc.agent, URL, { home, cwd, env, ctx });
      expect(again!.result.status).toBe('unchanged');
      const rv = AGENTS[tc.agent].revert!(file, { ...ctx, releaseDurable: true });
      expect(rv.status).toBe('reverted');
      expect(fs.readFileSync(file, 'utf8')).toBe(original);
      expect(fs.existsSync(wrapBackupPath(file))).toBe(false);
      expect(readMarker(file)).toBeNull();
    });
  }

  it('returns null for env-only agents and honours the project scope for Claude', () => {
    expect(applyProxyToAgent('aider', URL, { home: tmp(), cwd: tmp(), env: {} })).toBeNull();
    const home = tmp();
    const cwd = path.join(home, 'proj');
    fs.mkdirSync(cwd);
    const r = applyProxyToAgent('claude', URL, { home, cwd, env: {}, scope: 'project', ctx: { agent: 'claude', isAlive: () => false } });
    expect(r!.file).toBe(path.join(cwd, '.claude', 'settings.json'));
    expect(JSON.parse(fs.readFileSync(r!.file, 'utf8'))).toEqual({ env: { ANTHROPIC_BASE_URL: URL } });
  });
});
