import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildGraph } from '../src/engine/build.js';
import { setDiscoverDirectoryReaderForTests } from '../src/engine/discover.js';
import { serializeGraph } from '../src/engine/serialize.js';
import type { VgGraph } from '../src/schema.js';
import { cleanup, makeProject } from './helpers.js';

/**
 * `vg build` discovers source in one directory listing per directory, then
 * picks a language from the extension. Node's `fs` exports cannot be spied
 * on, so the count goes through the discovery reader hook.
 */
const PIN = '2020-01-01T00:00:00.000Z';

const FILES: Record<string, string> = {
  'src/app.ts': 'export const n = 1;\n',
  'src/py/app.py': 'n = 1\n',
  'svc/main.go': 'package main\n\nfunc main() {}\n',
  'jvm/pkg/App.java': 'class App {}\n',
  'rust/src/lib.rs': 'fn f() {}\n',
  'web/app.rb': 'def hi; end\n',
  'node_modules/pkg/index.js': 'module.exports = 1;\n',
  'hidden/secret.ts': 'export const secret = 1;\n',
  '.gitignore': 'hidden/\n',
};

/** Directories the single source walk enters. Skipped and ignored dirs stay out. */
const WALKED: Record<string, number> = {
  '.': 1,
  jvm: 1,
  'jvm/pkg': 1,
  rust: 1,
  'rust/src': 1,
  src: 1,
  'src/py': 1,
  svc: 1,
  web: 1,
};

const SOURCE_FILES = [
  'jvm/pkg/App.java',
  'rust/src/lib.rs',
  'src/app.ts',
  'src/py/app.py',
  'svc/main.go',
  'web/app.rb',
];

const dirs: string[] = [];
function project(files: Record<string, string>): string {
  const d = makeProject(files);
  dirs.push(d);
  return d;
}

afterEach(() => {
  setDiscoverDirectoryReaderForTests(null);
  while (dirs.length) cleanup(dirs.pop()!);
});

function readCounts(reads: Map<string, number>): Record<string, number> {
  return Object.fromEntries([...reads.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)));
}

function sourceFiles(graph: VgGraph): string[] {
  return graph.nodes
    .filter((n) => n.kind === 'file')
    .map((n) => n.file)
    .sort();
}

async function buildCountingReads(
  root: string,
  only?: string[],
): Promise<{ graph: VgGraph; reads: Map<string, number> }> {
  const reads = new Map<string, number>();
  setDiscoverDirectoryReaderForTests((dir) => {
    const rel = path.relative(root, dir);
    const key = rel ? rel.split(path.sep).join('/') : '.';
    reads.set(key, (reads.get(key) ?? 0) + 1);
    return fs.readdirSync(dir, { withFileTypes: true });
  });
  try {
    const { graph } = await buildGraph({
      root,
      generatedAt: PIN,
      inline: true,
      noCache: true,
      ...(only ? { only } : {}),
    });
    return { graph, reads };
  } finally {
    setDiscoverDirectoryReaderForTests(null);
  }
}

describe('vg build discovery walk', () => {
  it('reads each directory once across a multi-language tree', async () => {
    const root = project(FILES);

    const full = await buildCountingReads(root);
    expect(readCounts(full.reads)).toEqual(WALKED);
    expect(sourceFiles(full.graph)).toEqual(SOURCE_FILES);
    expect(full.graph.meta.languages).toEqual(expect.arrayContaining(['go', 'java', 'py', 'rb', 'rust', 'ts']));
    expect(full.graph.meta.languages).toHaveLength(6);

    const plain = serializeGraph(
      (await buildGraph({ root, generatedAt: PIN, inline: true, noCache: true })).graph,
    );
    expect(serializeGraph(full.graph)).toBe(plain);

    const tsOnly = await buildCountingReads(root, ['ts']);
    expect(readCounts(tsOnly.reads)).toEqual(WALKED);
    expect(sourceFiles(tsOnly.graph)).toEqual(['src/app.ts']);
    expect(tsOnly.graph.meta.languages).toEqual(['ts']);
  });
});
