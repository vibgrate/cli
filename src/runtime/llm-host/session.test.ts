import { describe, it, expect, beforeEach } from 'vitest';
import {
  acquireHostSession,
  clearHostSessionPool,
  generateOnSession,
  hostSessionPoolSize,
  evictIdleSessions,
  sessionKey,
} from './session.js';
import { buildIdentifierTrieFromGraph } from '../identifier-trie.js';

function fakeLib(reply = 'generated-text') {
  return {
    getLlama: async () => ({
      loadModel: async () => ({
        createContext: async () => ({
          getSequence: () => ({}),
        }),
        tokenize: (s: string) => s.split(''),
      }),
    }),
    LlamaChatSession: class {
      async prompt() {
        return reply;
      }
    },
  };
}

describe('host session pool', () => {
  beforeEach(() => clearHostSessionPool());

  it('reuses a warm session for the same model path', async () => {
    const lib = fakeLib();
    const a = await acquireHostSession(lib, '/models/a.gguf');
    const b = await acquireHostSession(lib, '/models/a.gguf');
    expect(a).toBe(b);
    expect(hostSessionPoolSize()).toBe(1);
    expect(sessionKey('/models/a.gguf')).toMatch(/embedded:/);
  });

  it('generateOnSession returns metrics and applies identifier annotation', async () => {
    const lib = fakeLib('call ghostFn and readConfig');
    const session = await acquireHostSession(lib, '/m.gguf');
    const trie = buildIdentifierTrieFromGraph({ nodes: [{ name: 'readConfig' }] });
    const res = await generateOnSession(
      session,
      [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'fix the signature' },
      ],
      {
        identifierTrie: trie,
        promptSegments: [
          { kind: 'system', text: 'sys' },
          { kind: 'user', text: 'fix the signature' },
        ],
      },
    );
    expect(res.text).toMatch(/ghostFn|unknown identifiers/);
    expect(res.unknownIdentifiers).toContain('ghostFn');
    expect(res.kvPlan).toBeDefined();
    expect(res.kvPlan!.miss.length).toBeGreaterThan(0);
    expect(res.latencyMs).toBeGreaterThanOrEqual(0);
    expect(typeof res.samplerHook).toBe('boolean');
    expect(res.samplerMethod).toBeDefined();

    // Second turn: system segment should hit KV plan + report prefix reuse tokens.
    const res2 = await generateOnSession(
      session,
      [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'again' },
      ],
      {
        promptSegments: [
          { kind: 'system', text: 'sys' },
          { kind: 'user', text: 'again' },
        ],
      },
    );
    expect(res2.kvPlan!.hit.length).toBeGreaterThanOrEqual(1);
    expect(res2.kvPrefixReusedTokens ?? 0).toBeGreaterThan(0);
  });

  it('applies TokenBias when binding exposes TokenBias + tokenize', async () => {
    class TokenBias {
      constructor(_t: unknown) {}
      set(_token: unknown, _v: unknown) {}
    }
    const lib = {
      TokenBias,
      getLlama: async () => ({
        loadModel: async () => ({
          tokenizer: {},
          tokenize: (s: string) => [s],
          detokenize: (t: unknown[]) => String(t[0] ?? ''),
          iterateAllTokens: function* () {
            yield 'ghostFn';
          },
          createContext: async () => ({
            getSequence: () => ({}),
          }),
        }),
      }),
      LlamaChatSession: class {
        lastOpts: unknown;
        async prompt(_p: string, opts?: unknown) {
          this.lastOpts = opts;
          return 'ok';
        }
      },
    };
    const session = await acquireHostSession(lib, '/bias.gguf');
    const trie = buildIdentifierTrieFromGraph({ nodes: [{ name: 'readConfig' }] });
    const res = await generateOnSession(session, [{ role: 'user', content: 'hi' }], {
      identifierTrie: trie,
      suppressUnknownLogits: true,
    });
    expect(res.samplerHook).toBe(true);
    expect(res.samplerBoostedTokens ?? 0).toBeGreaterThan(0);
  });

  it('composes dynamic onToken sampler when capability assumed', async () => {
    class TokenBias {
      constructor(_t: unknown) {}
      set() {}
    }
    let seenOnToken = false;
    const lib = {
      TokenBias,
      getLlama: async () => ({
        loadModel: async () => ({
          tokenizer: {},
          tokenize: (s: string) => [s],
          detokenize: (t: unknown[]) => String(t[0] ?? ''),
          iterateAllTokens: function* () {},
          createContext: async () => ({ getSequence: () => ({}) }),
        }),
      }),
      LlamaChatSession: class {
        async prompt(_p: string, opts?: Record<string, unknown>) {
          if (typeof opts?.onToken === 'function') seenOnToken = true;
          return 'readConfig()';
        }
      },
    };
    const session = await acquireHostSession(lib, '/dyn.gguf');
    const trie = buildIdentifierTrieFromGraph({ nodes: [{ name: 'readConfig' }] });
    const res = await generateOnSession(session, [{ role: 'user', content: 'hi' }], {
      identifierTrie: trie,
      assumeOnToken: true,
      suppressUnknownLogits: false,
    });
    expect(res.dynamicSampler).toBe(true);
    expect(res.constraintLayers?.dynamic).toBe(true);
    expect(seenOnToken).toBe(true);
    expect(res.bindingCaps?.length).toBeGreaterThan(0);
  });

  it('multi-turn cursor reports kvDeltaTokens', async () => {
    const lib = fakeLib('ok');
    const session = await acquireHostSession(lib, '/kv-delta.gguf');
    const segs = (user: string) => [
      { kind: 'system', text: 'sys-stable' },
      { kind: 'capsule', text: 'cap-stable' },
      { kind: 'user', text: user },
    ];
    await generateOnSession(session, [{ role: 'system', content: 'sys-stable' }, { role: 'user', content: 't1' }], {
      promptSegments: segs('t1'),
    });
    const res2 = await generateOnSession(session, [{ role: 'system', content: 'sys-stable' }, { role: 'user', content: 't2' }], {
      promptSegments: segs('t2'),
    });
    expect(res2.kvPlan?.cursorSkipBlocks).toBeGreaterThanOrEqual(2);
    expect(typeof res2.kvDeltaTokens).toBe('number');
  });

  it('does not accept a random graph draft just because evaluate exists', async () => {
    // evaluateWithoutGeneratingNewTokens is not draft verification — prepending
    // a signature that merely tokenizes poisoned every answer (fmtLong, …).
    const lib = {
      getLlama: async () => ({
        loadModel: async () => ({
          createContext: async () => ({
            getSequence: () => ({
              evaluateWithoutGeneratingNewTokens: async () => {},
            }),
          }),
          tokenize: (s: string) => s.split(''),
        }),
      }),
      LlamaChatSession: class {
        async prompt() {
          return 'real answer about dependencies';
        }
      },
    };
    const session = await acquireHostSession(lib, '/m2.gguf');
    const draft = 'fmtLong = (d) => new Date(d).toLocaleDateString';
    const res = await generateOnSession(
      session,
      [{ role: 'user', content: 'check for high risk dependencies' }],
      { draftCandidates: [draft] },
    );
    expect(res.text).toBe('real answer about dependencies');
    expect(res.draftAcceptedChars).toBe(0);
    expect(res.text).not.toContain('fmtLong');
  });

  it('resets LlamaChatSession so turn 2 does not inherit turn 1 chat history', async () => {
    let chatInstances = 0;
    const lib = {
      getLlama: async () => ({
        loadModel: async () => ({
          createContext: async () => ({ getSequence: () => ({}) }),
        }),
      }),
      LlamaChatSession: class {
        constructor() {
          chatInstances++;
        }
        async prompt() {
          return `reply-${chatInstances}`;
        }
      },
    };
    const session = await acquireHostSession(lib, '/hist.gguf');
    const r1 = await generateOnSession(session, [{ role: 'user', content: 'where is stripe' }]);
    const r2 = await generateOnSession(session, [{ role: 'user', content: 'high risk deps' }]);
    // One session construct at acquire + one per generate (fresh history each turn).
    expect(chatInstances).toBeGreaterThanOrEqual(3);
    expect(r1.text).toMatch(/reply-/);
    expect(r2.text).toMatch(/reply-/);
    expect(r2.text).not.toBe(r1.text);
  });

  it('evicts idle sessions under pressure', async () => {
    await acquireHostSession(fakeLib(), '/a.gguf');
    await acquireHostSession(fakeLib(), '/b.gguf');
    await acquireHostSession(fakeLib(), '/c.gguf');
    expect(hostSessionPoolSize()).toBe(3);
    const dropped = evictIdleSessions(1, 0);
    expect(dropped).toBeGreaterThanOrEqual(2);
    expect(hostSessionPoolSize()).toBeLessThanOrEqual(1);
  });

  it('fail-closes when requireGrammar and binding cannot attach grammar', async () => {
    const session = await acquireHostSession(fakeLib(), '/no-grammar.gguf');
    await expect(
      generateOnSession(session, [{ role: 'user', content: 'hi' }], {
        grammar: 'root ::= "x"',
        requireGrammar: true,
        env: {},
      }),
    ).rejects.toThrow(/constrained decoding required/);
  });

  it('accepts requireGrammar when LlamaGrammar is available', async () => {
    class LlamaGrammar {
      constructor(_a: unknown, _b: { grammar: string }) {}
    }
    const lib = {
      ...fakeLib('ok'),
      LlamaGrammar,
      getLlama: async () => ({}),
    };
    // Rebuild fake with LlamaGrammar on the module used by acquire
    const session = await acquireHostSession(
      {
        getLlama: async () => ({
          loadModel: async () => ({
            createContext: async () => ({ getSequence: () => ({}) }),
          }),
        }),
        LlamaChatSession: class {
          async prompt() {
            return '{}';
          }
        },
        LlamaGrammar,
      },
      '/with-grammar.gguf',
    );
    const res = await generateOnSession(session, [{ role: 'user', content: 'hi' }], {
      grammar: 'root ::= "x"',
      requireGrammar: true,
      env: {},
    });
    expect(res.grammarApplied).toBe(true);
    expect(res.grammarMethod).toBe('LlamaGrammar');
  });
});
