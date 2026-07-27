import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import {
  createLlmHost,
  EmbeddedLlmHost,
  ProcessLlmHost,
  LLM_HOST_IPC_SCHEMA,
  startProcessHostServer,
  resolveInferenceIsolation,
  generateWithLlamaBinding,
  clearHostSessionPool,
} from './index.js';

describe('createLlmHost', () => {
  it('defaults to embedded (Approach B)', () => {
    const host = createLlmHost();
    expect(host).toBeInstanceOf(EmbeddedLlmHost);
    expect(host.isolation).toBe('embedded');
  });

  it('process isolation returns ProcessLlmHost with endpoint', () => {
    const host = createLlmHost({ isolation: 'process', endpoint: '/tmp/vg-test.sock' });
    expect(host).toBeInstanceOf(ProcessLlmHost);
    expect(host.isolation).toBe('process');
    expect((host as ProcessLlmHost).getEndpoint()).toBe('/tmp/vg-test.sock');
  });
});

describe('resolveInferenceIsolation', () => {
  it('reads env', () => {
    expect(resolveInferenceIsolation(undefined, {})).toBe('embedded');
    expect(resolveInferenceIsolation(undefined, { VIBGRATE_INFERENCE_ISOLATION: 'process' })).toBe('process');
    expect(resolveInferenceIsolation('process', { VIBGRATE_INFERENCE_ISOLATION: 'embedded' })).toBe('process');
  });
});

describe('EmbeddedLlmHost', () => {
  it('requires load before generate', async () => {
    const host = new EmbeddedLlmHost();
    await expect(host.generate([{ role: 'user', content: 'hi' }])).rejects.toThrow(/no model loaded/);
  });

  it('requires binding after load', async () => {
    const host = new EmbeddedLlmHost();
    await host.load('/models/x.gguf');
    await expect(host.generate([{ role: 'user', content: 'hi' }])).rejects.toThrow(/binding not attached|node-llama-cpp/);
  });

  it('generate uses injected binding', async () => {
    const host = new EmbeddedLlmHost();
    const fakeLib = {
      getLlama: async () => ({
        loadModel: async () => ({
          createContext: async () => ({ getSequence: () => ({}) }),
        }),
      }),
      LlamaChatSession: class {
        async prompt() {
          return 'ok-from-binding';
        }
      },
    };
    host.setBinding(fakeLib);
    await host.load('/models/x.gguf');
    const res = await host.generate([{ role: 'user', content: 'hello' }]);
    expect(res.text).toBe('ok-from-binding');
    expect(res.isolation).toBe('embedded');
    await host.unload();
    expect(host.memoryReport().loaded).toBe(false);
  });

  it('annotates unknown identifiers when trie is provided', async () => {
    const { buildIdentifierTrieFromGraph } = await import('../identifier-trie.js');
    const host = new EmbeddedLlmHost();
    host.setBinding({
      getLlama: async () => ({
        loadModel: async () => ({ createContext: async () => ({ getSequence: () => ({}) }) }),
      }),
      LlamaChatSession: class {
        async prompt() {
          return 'call ghostFunction now';
        }
      },
    });
    await host.load('/m.gguf');
    const trie = buildIdentifierTrieFromGraph({ nodes: [{ name: 'realFn' }] });
    const res = await host.generate([{ role: 'user', content: 'x' }], { identifierTrie: trie });
    expect(res.unknownIdentifiers).toContain('ghostFunction');
    expect(res.text).toMatch(/unknown identifiers/);
  });
});

describe('generateWithLlamaBinding', () => {
  it('rejects invalid module', async () => {
    await expect(
      generateWithLlamaBinding({ lib: {}, modelPath: '/x', messages: [{ role: 'user', content: 'a' }] }),
    ).rejects.toThrow(/getLlama/);
  });
});

describe('process host IPC', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  it('round-trips load + generate over the socket', async () => {
    clearHostSessionPool();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-llm-host-'));
    dirs.push(dir);
    const sock = path.join(dir, 'h.sock');
    const fakeLib = {
      getLlama: async () => ({
        loadModel: async () => ({
          createContext: async () => ({ getSequence: () => ({}) }),
        }),
      }),
      LlamaChatSession: class {
        async prompt() {
          return 'from-process';
        }
      },
    };
    const server = await startProcessHostServer({ socketPath: sock, binding: fakeLib });
    try {
      const client = new ProcessLlmHost(sock);
      // Unique path so we do not reuse a warm session from earlier tests.
      await client.load(`/tmp/process-unique-${Date.now()}.gguf`);
      const out = await client.generate([{ role: 'user', content: 'hi' }]);
      expect(out.text).toBe('from-process');
      expect(out.isolation).toBe('process');
      const mem = await client.memoryReportAsync();
      expect(mem.loaded).toBe(true);
      await client.unload();
    } finally {
      await server.close();
      clearHostSessionPool();
    }
  });
});

describe('IPC schema', () => {
  it('is versioned', () => {
    expect(LLM_HOST_IPC_SCHEMA).toBe('llm-host-ipc/0');
  });
});
