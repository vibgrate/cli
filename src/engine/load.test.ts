import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildProgram } from '../cli.js';
import { CliError, ExitCode } from '../util/exit.js';
import { loadGraph } from './load.js';
import { GraphLoadError, parseGraph, serializeGraph } from './serialize.js';
import { writeGraphSnapshot } from './snapshot.js';
import type { SupportedSchemaVersion, VgGraph } from '../schema.js';

/**
 * A truncated, invalid, or unsupported code map must stop the commands that
 * load it. A missing map stays "missing". A map this version already reads
 * still loads. Messages name the failure, say to rebuild, and do not quote
 * the file.
 */

const SENTINEL = 'SECRET_SENTINEL_7f3a';

const TRUNCATED = 'code map is truncated — rebuild it with `vg build`';
const INVALID = 'code map is not valid JSON — rebuild it with `vg build`';
const UNSUPPORTED_NAMED =
  'code map uses schema vg-graph/9.0, which this version cannot read — rebuild it with `vg build`';
const UNSUPPORTED_UNNAMED =
  'code map uses a schema this version cannot read — rebuild it with `vg build`';

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-load-'));
  dirs.push(dir);
  return dir;
}

function supported(schemaVersion: SupportedSchemaVersion): VgGraph {
  return {
    schemaVersion,
    generatedAt: '2026-01-01T00:00:00.000Z',
    provenance: {
      tool: 'vg',
      version: '0.0.0-test',
      grammars: {},
      resolver: ['heuristic'],
      deep: false,
      corpusHash: 'abc',
    },
    meta: {
      root: '.',
      languages: ['typescript'],
      counts: { nodes: 1, edges: 0, areas: 0, tests: 0, untested: 0 },
      cluster: 'none',
      edgeKinds: [],
    },
    nodes: [
      {
        id: 'n1',
        kind: 'function',
        name: 'alpha',
        qualifiedName: 'src/a.ts:alpha',
        file: 'src/a.ts',
        span: { start: 1, end: 2 },
        lang: 'typescript',
        importance: 0.5,
        centrality: { degree: 0, pagerank: 0, betweenness: 0, eigenvector: 0 },
        area: -1,
        isHub: false,
        tested: null,
      },
    ],
    edges: [],
    areas: [],
  };
}

/** Cut a real map after a sentinel so the file bytes include it and the JSON does not close. */
function truncatedDocument(): string {
  const full = serializeGraph(supported('vg-graph/1.1')).replace('alpha', `alpha ${SENTINEL}`);
  const at = full.indexOf(SENTINEL);
  if (at < 0) throw new Error('sentinel missing from fixture');
  return full.slice(0, at + SENTINEL.length);
}

function writeMap(dir: string, body: string): string {
  const file = path.join(dir, 'graph.json');
  fs.writeFileSync(file, body);
  return file;
}

async function run(args: string[]): Promise<string> {
  const program = buildProgram();
  program.exitOverride();
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((s: string | Uint8Array) => {
    chunks.push(String(s));
    return true;
  });
  try {
    await program.parseAsync(args, { from: 'user' });
  } finally {
    spy.mockRestore();
  }
  return chunks.join('');
}

async function fail(args: string[]): Promise<unknown> {
  try {
    await run(args);
  } catch (err) {
    return err;
  }
  throw new Error(`expected ${args.join(' ')} to fail`);
}

function assertNoFileContents(message: string): void {
  expect(message).not.toContain(SENTINEL);
  expect(message).not.toContain('Unexpected token');
}

describe('parseGraph / loadGraph', () => {
  it('rejects a truncated map without quoting the file', () => {
    const body = truncatedDocument();
    expect(body).toContain(SENTINEL);
    let thrown: unknown;
    try {
      parseGraph(body);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(GraphLoadError);
    const error = thrown as GraphLoadError;
    expect(error.failure).toBe('truncated');
    expect(error.code).toBe(ExitCode.ERROR);
    expect(error.message).toBe(TRUNCATED);
    assertNoFileContents(error.message);
  });

  it('rejects invalid JSON without quoting the file', () => {
    const body = `{ "note": "${SENTINEL}" oops`;
    let thrown: unknown;
    try {
      parseGraph(body);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(GraphLoadError);
    const error = thrown as GraphLoadError;
    expect(error.failure).toBe('invalid-json');
    expect(error.code).toBe(ExitCode.ERROR);
    expect(error.message).toBe(INVALID);
    assertNoFileContents(error.message);
  });

  it('rejects a schema this version cannot read, and does not echo an unsafe schema string', () => {
    const named = JSON.stringify({
      schemaVersion: 'vg-graph/9.0',
      nodes: [{ name: SENTINEL }],
      edges: [],
      areas: [],
    });
    const namedErr = (() => {
      try {
        parseGraph(named);
      } catch (e) {
        return e;
      }
      throw new Error('expected named schema to fail');
    })();
    expect(namedErr).toBeInstanceOf(GraphLoadError);
    expect((namedErr as GraphLoadError).failure).toBe('unsupported-schema');
    expect((namedErr as GraphLoadError).message).toBe(UNSUPPORTED_NAMED);
    assertNoFileContents((namedErr as GraphLoadError).message);

    const unsafe = JSON.stringify({ schemaVersion: `${SENTINEL}\nnot-a-token`, nodes: [] });
    let unsafeErr: unknown;
    try {
      parseGraph(unsafe);
    } catch (e) {
      unsafeErr = e;
    }
    expect(unsafeErr).toBeInstanceOf(GraphLoadError);
    expect((unsafeErr as GraphLoadError).message).toBe(UNSUPPORTED_UNNAMED);
    assertNoFileContents((unsafeErr as GraphLoadError).message);
  });

  it('returns null when the map is missing', () => {
    const dir = tempDir();
    const missing = path.join(dir, 'absent.json');
    expect(loadGraph(dir, missing)).toBeNull();
  });

  it('loads maps this version already supports', () => {
    for (const schema of ['vg-graph/1.0', 'vg-graph/1.1'] as const) {
      const graph = supported(schema);
      const text = serializeGraph(graph);
      expect(parseGraph(text)).toEqual(graph);
      const dir = tempDir();
      const file = writeMap(dir, text);
      expect(loadGraph(dir, file)).toEqual(graph);
    }
  });

  it('rejects an unsupported schema carried by a standalone snapshot', () => {
    const dir = tempDir();
    const file = path.join(dir, 'graph.json');
    const graph = supported('vg-graph/1.0');
    (graph as { schemaVersion: string }).schemaVersion = 'vg-graph/9.0';
    expect(writeGraphSnapshot(file, graph, { standalone: true })).toBe(true);
    expect(() => loadGraph(dir, file)).toThrow(GraphLoadError);
    try {
      loadGraph(dir, file);
    } catch (e) {
      expect((e as GraphLoadError).message).toBe(UNSUPPORTED_NAMED);
      assertNoFileContents((e as GraphLoadError).message);
    }
  });
});

describe('commands that load the code map', () => {
  const commands = ['show', 'impact', 'ask'] as const;

  async function loadFailure(command: (typeof commands)[number], file: string, dir: string): Promise<GraphLoadError> {
    const err = await fail([command, 'alpha', '--graph', file, '--cwd', dir]);
    expect(err).toBeInstanceOf(GraphLoadError);
    expect(err).toBeInstanceOf(CliError);
    const error = err as GraphLoadError;
    expect(error.code).toBe(ExitCode.ERROR);
    expect(error.code).not.toBe(0);
    assertNoFileContents(error.message);
    return error;
  }

  it('stops with a non-zero truncated error', async () => {
    const dir = tempDir();
    const file = writeMap(dir, truncatedDocument());
    for (const command of commands) {
      const error = await loadFailure(command, file, dir);
      expect(error.failure).toBe('truncated');
      expect(error.message).toBe(TRUNCATED);
    }
  });

  it('stops with a non-zero invalid-JSON error', async () => {
    const dir = tempDir();
    const file = writeMap(dir, `{ "note": "${SENTINEL}" oops`);
    for (const command of commands) {
      const error = await loadFailure(command, file, dir);
      expect(error.failure).toBe('invalid-json');
      expect(error.message).toBe(INVALID);
    }
  });

  it('stops with a non-zero unsupported-schema error', async () => {
    const dir = tempDir();
    const file = writeMap(
      dir,
      JSON.stringify({ schemaVersion: 'vg-graph/9.0', nodes: [{ name: SENTINEL }], edges: [], areas: [] }),
    );
    for (const command of commands) {
      const error = await loadFailure(command, file, dir);
      expect(error.failure).toBe('unsupported-schema');
      expect(error.message).toBe(UNSUPPORTED_NAMED);
    }
  });

  it('still reports a missing map as missing', async () => {
    const dir = tempDir();
    const missing = path.join(dir, 'absent.json');
    for (const command of commands) {
      const err = await fail([command, 'alpha', '--graph', missing, '--cwd', dir]);
      expect(err).toBeInstanceOf(CliError);
      expect(err).not.toBeInstanceOf(GraphLoadError);
      const error = err as CliError;
      expect(error.code).toBe(ExitCode.NOT_FOUND);
      expect(error.message).toContain('no map found');
      expect(error.message).not.toContain('truncated');
      expect(error.message).not.toContain('not valid JSON');
      expect(error.message).not.toContain('cannot read');
      expect(error.message).not.toContain('`vg build`');
    }
  });

  it('loads a supported map for show and impact', async () => {
    for (const schema of ['vg-graph/1.0', 'vg-graph/1.1'] as const) {
      const dir = tempDir();
      const file = writeMap(dir, serializeGraph(supported(schema)));
      const shown = await run(['show', 'alpha', '--json', '--graph', file, '--cwd', dir]);
      expect(JSON.parse(shown).name).toBe('src/a.ts:alpha');
      const impact = await run(['impact', 'alpha', '--json', '--graph', file, '--cwd', dir]);
      expect(JSON.parse(impact).root.name).toBe('src/a.ts:alpha');
    }
  });
});
