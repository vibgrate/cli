/**
 * Pluggable inference backend detection (Code Modes PRD §7.2).
 *
 * Adapters report availability and list local models. They do not install
 * third-party apps. Used by status UX and future router preferred-backend picks.
 */

import { spawnSync } from 'node:child_process';
import { discoverModels, type LocalModel } from '../engine/models.js';
import { hasOllamaBinary } from '../util/resolve-ollama.js';
import { listCachedWeights } from './weight-store.js';

export type InferenceBackendId = 'ollama' | 'llama.cpp' | 'lm-studio' | 'foundry-local' | 'vibgrate-store';

export interface BackendHealth {
  id: InferenceBackendId;
  available: boolean;
  label: string;
  detail?: string;
  /** Model ids/paths this backend can serve right now. */
  models: string[];
}

export interface ProbeOptions {
  discover?: () => LocalModel[];
  hasBinary?: (name: string) => boolean;
  env?: NodeJS.ProcessEnv;
  /** HTTP probe for LM Studio OpenAI-compatible server. */
  probeHttp?: (url: string) => boolean;
  /** Optional model list fetch for OpenAI-compatible local servers. */
  listModels?: (baseUrl: string) => string[];
}

function defaultHasBinary(name: string): boolean {
  if (name === 'ollama' || name === 'ollama.exe') return hasOllamaBinary();
  const res = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], { stdio: 'ignore' });
  return res.status === 0;
}

function defaultProbeHttp(url: string): boolean {
  try {
    // Sync-ish via curl when available; avoid hard dependency on fetch in Node versions.
    const res = spawnSync('curl', ['-sS', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '1', url], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const code = String(res.stdout || '').trim();
    return res.status === 0 && code.startsWith('2');
  } catch {
    return false;
  }
}

/** Probe all known local inference backends. */
export function probeInferenceBackends(options: ProbeOptions = {}): BackendHealth[] {
  const hasBinary = options.hasBinary ?? defaultHasBinary;
  const discover = options.discover ?? (() => discoverModels());
  const probeHttp = options.probeHttp ?? defaultProbeHttp;
  const env = options.env ?? process.env;
  const fleet = discover();

  const ollamaModels = fleet.filter((m) => m.runtime === 'ollama').map((m) => m.name);
  const lmModels = fleet.filter((m) => m.runtime === 'lm-studio').map((m) => m.name);
  const ggufModels = fleet.filter((m) => m.runtime === 'gguf').map((m) => m.name);
  const store = listCachedWeights(env);

  const lmBase = env.LMSTUDIO_BASE_URL || 'http://127.0.0.1:1234/v1';
  const lmServerUp = probeHttp(`${lmBase.replace(/\/$/, '')}/models`);

  const foundryBase = env.FOUNDRY_LOCAL_BASE_URL || 'http://127.0.0.1:5272/v1';
  const foundryServerUp = probeHttp(`${foundryBase.replace(/\/$/, '')}/models`);
  const foundryBin = hasBinary('foundry') || hasBinary('foundry.exe');
  const foundryModels = listOpenAiModels(foundryBase, options.listModels);

  return [
    {
      id: 'ollama',
      label: 'Ollama',
      available: hasBinary('ollama'),
      detail: hasBinary('ollama') ? `${ollamaModels.length} model(s) on disk` : 'install from https://ollama.com',
      models: ollamaModels,
    },
    {
      id: 'lm-studio',
      label: 'LM Studio',
      available: lmModels.length > 0 || lmServerUp,
      detail: lmServerUp ? `server ${lmBase}` : lmModels.length ? `${lmModels.length} gguf under ~/.lmstudio` : 'app or local server not detected',
      models: lmModels,
    },
    {
      id: 'foundry-local',
      label: 'Foundry Local',
      available: foundryBin || foundryServerUp || foundryModels.length > 0,
      detail: foundryServerUp
        ? `server ${foundryBase}${foundryModels.length ? ` · ${foundryModels.length} model(s)` : ''}`
        : foundryBin
          ? 'foundry CLI on PATH (start the local server to list models)'
          : 'Microsoft Foundry Local not detected (Windows NPU/GPU path)',
      models: foundryModels,
    },
    {
      id: 'llama.cpp',
      label: 'llama.cpp (embedded)',
      available: ggufModels.length > 0 || store.length > 0,
      detail: 'GGUF via --model-path, weight store, or ~/models',
      models: [...ggufModels, ...store.map((s) => s.name)],
    },
    {
      id: 'vibgrate-store',
      label: 'Vibgrate weight store',
      available: store.length > 0,
      detail: `${store.length} cached gguf(s)`,
      models: store.map((s) => s.name),
    },
  ];
}

export function summarizeBackendHealth(health: BackendHealth[]): string {
  const up = health.filter((h) => h.available).map((h) => h.id);
  return up.length ? `backends: ${up.join(', ')}` : 'no local inference backends detected';
}

/** Best-effort GET {base}/models → id list (sync curl for zero deps). */
function listOpenAiModels(baseUrl: string, inject?: (base: string) => string[]): string[] {
  if (inject) return inject(baseUrl);
  try {
    const url = `${baseUrl.replace(/\/$/, '')}/models`;
    const res = spawnSync('curl', ['-sS', '--max-time', '1', url], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    if (res.status !== 0 || !res.stdout) return [];
    const data = JSON.parse(res.stdout) as { data?: Array<{ id?: string }> };
    return (data.data ?? []).map((m) => m.id).filter((id): id is string => !!id);
  } catch {
    return [];
  }
}
