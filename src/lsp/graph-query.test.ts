import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * An editor Ask must ALWAYS come back.
 *
 * `vibgrate/graph/query` is answered inside a long-lived LSP request, and the
 * editor renders a "Searching…" placeholder for its whole duration. The
 * semantic path is the slow, optional, failure-prone half of it — a missing
 * native backend, a cold model download, or an un-embedded corpus can each take
 * minutes or never finish. None of them may hold the request open: the
 * deterministic lexical floor answers instead, and the note explains why.
 */

// The embedder is the thing under test's slow dependency — stub it per case.
// `withTimeout` is real: the budget it enforces is the behaviour being proven.
const loadEmbedder = vi.hoisted(() => vi.fn());
const getNodeEmbeddings = vi.hoisted(() => vi.fn());

vi.mock('../engine/embeddings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../engine/embeddings.js')>();
  return { ...actual, loadEmbedder, getNodeEmbeddings };
});

const { runGraphQuery } = await import('./graph-query.js');
const { buildGraph } = await import('../engine/build.js');

let root: string;
let graph: Awaited<ReturnType<typeof buildGraph>>['graph'];

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-graph-query-'));
  fs.writeFileSync(
    path.join(root, 'auth.ts'),
    [
      'export function verifyPassword(user: string, password: string): boolean {',
      '  return user.length > 0 && password.length > 0;',
      '}',
      'export function issueSessionToken(user: string): string {',
      '  return `token-for-${user}`;',
      '}',
    ].join('\n'),
  );
  graph = (await buildGraph({ root })).graph;
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const ask = (semantic: boolean, offline = false) =>
  runGraphQuery(
    graph,
    { mode: 'ask', question: 'how are passwords verified', semantic },
    { root, offline, semantic: true },
  );

/** The shape every case below must satisfy: an answer, never a hang. */
function expectLexicalAnswer(result: Awaited<ReturnType<typeof ask>>): Record<string, unknown> {
  expect(result.ok).toBe(true);
  const data = (result as { data: Record<string, unknown> }).data;
  expect(data.mode).toBe('lexical');
  expect(Array.isArray(data.matches)).toBe(true);
  return data;
}

describe('runGraphQuery ask', () => {
  it('answers lexically, with a reason, when the semantic backend is missing', async () => {
    loadEmbedder.mockImplementation(async (opts: { onUnavailable?: (r: string) => void }) => {
      opts.onUnavailable?.('not-installed');
      return null;
    });

    const data = expectLexicalAnswer(await ask(true));
    expect(String(data.note)).toMatch(/lexical/i);
  });

  it('abandons a semantic path that overruns its budget and still answers', async () => {
    vi.stubEnv('VG_SEMANTIC_BUDGET_MS', '50');
    loadEmbedder.mockResolvedValue({ id: 'stub-model', embed: async () => [], embedQuery: async () => [] });
    // The failure this guards: embedding an un-cached corpus that never returns
    // inside the request. Before the budget, this hung the editor's Ask tab.
    getNodeEmbeddings.mockImplementation(() => new Promise(() => {}));

    const started = Date.now();
    const data = expectLexicalAnswer(await ask(true));
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(String(data.note)).toMatch(/did not finish in time/i);
    vi.unstubAllEnvs();
  });

  it('answers lexically when the semantic path throws', async () => {
    loadEmbedder.mockRejectedValue(new Error('native backend failed to load'));
    const data = expectLexicalAnswer(await ask(true));
    expect(String(data.note)).toMatch(/lexical/i);
  });

  it('never loads an embedder when the caller did not ask for semantic', async () => {
    loadEmbedder.mockClear();
    expectLexicalAnswer(await ask(false));
    expect(loadEmbedder).not.toHaveBeenCalled();
  });

  it('skips semantic while offline and says so', async () => {
    loadEmbedder.mockClear();
    const data = expectLexicalAnswer(await ask(true, true));
    expect(loadEmbedder).not.toHaveBeenCalled();
    expect(String(data.note)).toMatch(/offline/i);
  });

  it('traces its progress for the client output channel without echoing the question', async () => {
    loadEmbedder.mockResolvedValue(null);
    const lines: string[] = [];
    await runGraphQuery(
      graph,
      { mode: 'ask', question: 'how are passwords verified', semantic: true },
      { root, offline: false, semantic: true, log: (m) => lines.push(m) },
    );
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.some((l) => /answered with lexical/.test(l))).toBe(true);
    // Traces reach a shared output channel — they carry status, not user text.
    expect(lines.some((l) => l.includes('how are passwords verified'))).toBe(false);
  });
});

describe('runGraphQuery — ask via the local runtime', () => {
  const session = (rank: () => Promise<unknown>) => ({ attached: true, rank }) as never;

  it('ranks through the daemon, without loading a model in this process', async () => {
    let ranked = 0;
    // The suite shares one hoisted mock; clear it so "was never called" means
    // "was never called by THIS request".
    loadEmbedder.mockClear();
    loadEmbedder.mockImplementation(() => {
      throw new Error('the language server must not load the embedder when vgd ranked');
    });
    const target = graph.nodes.find((n) => n.name === 'verifyPassword')!;

    const result = await runGraphQuery(
      graph,
      { mode: 'ask', question: 'how are passwords verified', semantic: true },
      {
        root,
        offline: false,
        semantic: true,
        semanticSession: session(async () => {
          ranked++;
          return { ranked: [{ id: target.id, score: 0.9 }], vectors: 3, model: 'bge-small-en-v1.5' };
        }),
      },
    );

    expect(ranked).toBe(1);
    expect(result.ok).toBe(true);
    const data = (result as { data: Record<string, unknown> }).data;
    expect(String(data.mode)).toContain('vgd');
    expect(loadEmbedder).not.toHaveBeenCalled();
  });

  it('falls back to the in-process path when the daemon has no ranking', async () => {
    loadEmbedder.mockClear();
    loadEmbedder.mockResolvedValue(null);

    const result = await runGraphQuery(
      graph,
      { mode: 'ask', question: 'how are passwords verified', semantic: true },
      { root, offline: false, semantic: true, semanticSession: session(async () => null) },
    );

    expectLexicalAnswer(result);
    expect(loadEmbedder).toHaveBeenCalled();
  });

  it('never lets a daemon failure surface to the editor', async () => {
    loadEmbedder.mockResolvedValue(null);

    const result = await runGraphQuery(
      graph,
      { mode: 'ask', question: 'how are passwords verified', semantic: true },
      {
        root,
        offline: false,
        semantic: true,
        semanticSession: session(() => Promise.reject(new Error('socket gone'))),
      },
    );

    expectLexicalAnswer(result);
  });
});
