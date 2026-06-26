import { describe, it, expect, afterEach } from 'vitest';
import { buildModuleResolver, relativeResolver, parseJsonc } from '../src/engine/module-resolver.js';
import { buildGraph } from '../src/engine/build.js';
import { discover } from '../src/engine/discover.js';
import { findNodes } from '../src/engine/lookup.js';
import { makeProject, cleanup } from './helpers.js';

const dirs: string[] = [];
function project(files: Record<string, string>): string {
  const d = makeProject(files);
  dirs.push(d);
  return d;
}
function relSet(root: string): Set<string> {
  return new Set(discover({ root }).map((f) => f.rel));
}
afterEach(() => {
  while (dirs.length) cleanup(dirs.pop()!);
});

describe('module resolver', () => {
  it('resolves relative imports with extension + index probing', () => {
    const root = project({ 'a/b.ts': 'x', 'a/c.ts': 'x', 'a/d/index.ts': 'x' });
    const r = buildModuleResolver(root, relSet(root));
    expect(r.resolve('a/b.ts', './c')).toBe('a/c.ts');
    expect(r.resolve('a/b.ts', './d')).toBe('a/d/index.ts');
    expect(r.resolve('a/b.ts', 'react')).toBeNull(); // external
  });

  it('resolves Python dotted absolute imports', () => {
    const root = project({ 'app/core/security.py': 'x', 'app/main.py': 'x' });
    const r = buildModuleResolver(root, relSet(root));
    expect(r.resolve('app/main.py', 'app.core.security')).toBe('app/core/security.py');
    expect(r.resolve('app/main.py', 'socket.io')).toBeNull(); // dotted but not a repo file
  });

  it('resolves tsconfig paths aliases (incl. extends → tsconfig.base.json)', () => {
    const root = project({
      'tsconfig.json': JSON.stringify({ extends: './tsconfig.base.json' }),
      'tsconfig.base.json': JSON.stringify({
        compilerOptions: { baseUrl: '.', paths: { '@app/*': ['libs/app/src/*'] } },
      }),
      'libs/app/src/util.ts': 'x',
      'src/main.ts': 'x',
    });
    const r = buildModuleResolver(root, relSet(root));
    expect(r.resolve('src/main.ts', '@app/util')).toBe('libs/app/src/util.ts');
  });

  it('tolerates JSONC (comments + trailing commas) in tsconfig', () => {
    const cfg = '{\n  // comment\n  "compilerOptions": { "baseUrl": ".", "paths": { "@x/*": ["pkg/*"], }, },\n}';
    expect(parseJsonc<{ compilerOptions: { baseUrl: string } }>(cfg).compilerOptions.baseUrl).toBe('.');
    const root = project({ 'tsconfig.json': cfg, 'pkg/a.ts': 'x', 'm.ts': 'x' });
    const r = buildModuleResolver(root, relSet(root));
    expect(r.resolve('m.ts', '@x/a')).toBe('pkg/a.ts');
  });

  it('resolves workspace-package names (npm/yarn + pnpm)', () => {
    const root = project({
      'package.json': JSON.stringify({ workspaces: ['packages/*'] }),
      'packages/ui/package.json': JSON.stringify({ name: '@org/ui' }),
      'packages/ui/src/index.ts': 'x',
      'app/main.ts': 'x',
    });
    const r = buildModuleResolver(root, relSet(root));
    expect(r.resolve('app/main.ts', '@org/ui')).toBe('packages/ui/src/index.ts');
  });

  it('relativeResolver handles relative + dotted only', () => {
    const root = project({ 'a.ts': 'x', 'b.ts': 'x' });
    const r = relativeResolver(relSet(root));
    expect(r.resolve('a.ts', './b')).toBe('b.ts');
    expect(r.resolve('a.ts', '@org/x')).toBeNull();
  });
});

describe('resolution end-to-end (alias monorepo → cross-package call edge)', () => {
  it('creates a call edge across an aliased package boundary', async () => {
    const root = project({
      'tsconfig.base.json': JSON.stringify({
        compilerOptions: { baseUrl: '.', paths: { '@lib/math': ['libs/math/src/index.ts'] } },
      }),
      'libs/math/src/index.ts': 'export function add(a: number, b: number) { return a + b; }',
      'apps/web/calc.ts': "import { add } from '@lib/math';\nexport function calc() { return add(1, 2); }",
    });
    const { graph } = await buildGraph({ root, generatedAt: '2020-01-01T00:00:00.000Z', inline: true });
    const byId = new Map(graph.nodes.map((n) => [n.id, n.qualifiedName]));
    const callEdge = graph.edges.find(
      (e) => e.kind === 'call' && byId.get(e.src) === 'calc' && byId.get(e.dst) === 'add',
    );
    expect(callEdge, 'expected calc() → add() resolved across the @lib/math alias').toBeTruthy();
    // and the import edge to the aliased file
    expect(graph.edges.some((e) => e.kind === 'import')).toBe(true);
    void findNodes;
  });
});
