import { describe, it, expect, afterEach } from 'vitest';
import { discover, SKIP_DIRS, SKIP_FILES } from '../src/engine/discover.js';
import {
  SKIP_DIRS as SCANNER_SKIP_DIRS,
  SOURCE_EXCLUDE_FILES as SCANNER_EXCLUDE_FILES,
} from '../src/core-open/utils/fs.js';
import { buildGraph } from '../src/engine/build.js';
import { makeProject, cleanup } from './helpers.js';

const PIN = '2020-01-01T00:00:00.000Z';
const dirs: string[] = [];
function project(files: Record<string, string>): string {
  const d = makeProject(files);
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) cleanup(dirs.pop()!);
});

describe('graph discovery stays aligned with the scanner skip lists', () => {
  it('engine SKIP_DIRS covers every scanner SKIP_DIR', () => {
    const missing = [...SCANNER_SKIP_DIRS].filter((d) => !SKIP_DIRS.has(d));
    expect(missing).toEqual([]);
  });

  it('engine SKIP_FILES covers every scanner SOURCE_EXCLUDE_FILE', () => {
    const missing = [...SCANNER_EXCLUDE_FILES].filter((f) => !SKIP_FILES.has(f));
    expect(missing).toEqual([]);
  });

  it('every SKIP_FILES entry is lowercase (matching is by lowercased basename)', () => {
    for (const f of SKIP_FILES) expect(f).toBe(f.toLowerCase());
  });
});

describe('discover skips package folders and lockfiles', () => {
  it('excludes dependency/build directories at any depth', () => {
    const root = project({
      'src/app.ts': 'export function main(){ return 1; }',
      'Pods/Dep/dep.swift': 'func dep() {}',
      'deps/phoenix/lib/phoenix.ex': 'defmodule Phoenix do end',
      '_build/dev/lib/gen.ex': 'defmodule Gen do end',
      'packages/api/bower_components/lib/old.js': 'function old(){}',
      '.yarn/cache/pkg/index.js': 'module.exports = 1;',
      'DerivedData/Build/x.swift': 'func x() {}',
    });
    const rels = discover({ root }).map((f) => f.rel);
    expect(rels).toEqual(['src/app.ts']);
  });

  it('excludes lockfiles and generated dependency manifests (case-insensitive)', () => {
    const root = project({
      'index.ts': 'export const ok = 1;',
      '.pnp.cjs': 'module.exports = { resolveRequest() { return null; } };',
      '.pnp.loader.mjs': 'export function resolve() {}',
      'Cargo.lock': '[[package]]\nname = "x"\n',
    });
    const rels = discover({ root }).map((f) => f.rel);
    expect(rels).toEqual(['index.ts']);
  });

  it('the graph never indexes a lockfile module', async () => {
    const root = project({
      'a.ts': 'export function a(){ return 1; }',
      '.pnp.cjs': 'function phantom(){ return 1; }\nmodule.exports = phantom;',
    });
    const { graph } = await buildGraph({ root, generatedAt: PIN, inline: true });
    const files = graph.nodes.filter((n) => n.kind === 'file').map((n) => n.file);
    expect(files).toEqual(['a.ts']);
  });
});
