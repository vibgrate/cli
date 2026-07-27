import { describe, it, expect, afterEach } from 'vitest';
import { buildGraph } from '../src/engine/build.js';
import { parseSqlFile } from '../src/engine/sql-extract.js';
import { buildSummaries } from '../src/engine/summaries.js';
import { parseSource } from '../src/engine/parse.js';
import { makeProject, cleanup, SAMPLE_FILES } from './helpers.js';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) cleanup(dirs.pop()!);
});

function project(files: Record<string, string>): string {
  const d = makeProject(files);
  dirs.push(d);
  return d;
}

describe('hub summaries', () => {
  it('attaches precomputed blast-radius summaries on build', async () => {
    const root = project(SAMPLE_FILES);
    const { graph } = await buildGraph({
      root,
      generatedAt: '2020-01-01T00:00:00.000Z',
      noGround: true,
      inline: true,
    });
    expect(graph.summaries).toBeDefined();
    expect(graph.summaries!.hubs.length).toBeGreaterThan(0);
    const first = graph.summaries!.hubs[0];
    expect(first.name).toBeTruthy();
    expect(first.direct).toBeGreaterThanOrEqual(0);
    expect(first.depth2).toBeGreaterThanOrEqual(first.direct);

    // Pure recompute matches.
    const again = buildSummaries(graph);
    expect(again.hubs.map((h) => h.id)).toEqual(graph.summaries!.hubs.map((h) => h.id));
  });
});

describe('SQL DDL extract', () => {
  it('parses tables and FK references', () => {
    const p = parseSqlFile(
      'schema.sql',
      `
      CREATE TABLE users (id INT PRIMARY KEY);
      CREATE TABLE orders (id INT, user_id INT REFERENCES users(id));
    `,
    );
    expect(p.defs.map((d) => d.name).sort()).toEqual(['orders', 'users']);
    expect(p.heritage.some((h) => h.superName === 'users')).toBe(true);
  });

  it('is wired through parseSource', async () => {
    const p = await parseSource('db/schema.sql', 'sql', 'CREATE TABLE items (id INT);');
    expect(p.lang).toBe('sql');
    expect(p.defs.some((d) => d.name === 'items')).toBe(true);
  });

  it('builds into the graph as a language', async () => {
    const root = project({
      'schema.sql': 'CREATE TABLE widgets (id INT PRIMARY KEY);',
      'src/a.ts': 'export function f() { return 1 }\n',
    });
    const { graph } = await buildGraph({
      root,
      generatedAt: '2020-01-01T00:00:00.000Z',
      noGround: true,
      inline: true,
      noTsc: true,
    });
    expect(graph.meta.languages).toContain('sql');
    expect(graph.nodes.some((n) => n.name === 'widgets')).toBe(true);
  });
});
