import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isTestFile } from '../src/engine/tests.js';
import { buildGraph } from '../src/engine/build.js';
import { coveringTests, testsToRun, detectRunner } from '../src/engine/test-query.js';
import { findNodes } from '../src/engine/lookup.js';
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

const FILES = {
  'src/math.ts': 'export function add(a:number,b:number){return a+b;}\nexport function lonely(){return 0;}\n',
  'test/math.test.ts': "import { add } from '../src/math';\ntest('add', () => { add(1,2); });\n",
};

describe('isTestFile', () => {
  it('recognises common conventions', () => {
    expect(isTestFile('src/a.test.ts')).toBe(true);
    expect(isTestFile('__tests__/a.ts')).toBe(true);
    expect(isTestFile('test_foo.py')).toBe(true);
    expect(isTestFile('foo_test.go')).toBe(true);
    expect(isTestFile('MyServiceTest.java')).toBe(true);
    expect(isTestFile('foo_spec.rb')).toBe(true);
  });
  it('does not misfire on similar names', () => {
    expect(isTestFile('src/latest.java')).toBe(false);
    expect(isTestFile('src/contest.ts')).toBe(false);
  });
});

describe('static test linkage', () => {
  it('marks called code tested and adds test edges', async () => {
    const { graph } = await buildGraph({ root: project(FILES), generatedAt: PIN, inline: true });
    const add = findNodes(graph, 'add').find((n) => n.kind === 'function')!;
    const lonely = findNodes(graph, 'lonely').find((n) => n.kind === 'function')!;
    expect(add.tested).toBe(true);
    expect(lonely.tested).toBe(false);
    expect(graph.edges.some((e) => e.kind === 'test')).toBe(true);
    expect(graph.meta.counts.tests).toBe(1);
    expect(graph.meta.counts.untested).toBe(1);
  });

  it('coveringTests reports the covering test file', async () => {
    const { graph } = await buildGraph({ root: project(FILES), generatedAt: PIN, inline: true });
    const add = findNodes(graph, 'add').find((n) => n.kind === 'function')!;
    const covers = coveringTests(graph, add);
    expect(covers.map((c) => c.file)).toContain('test/math.test.ts');
  });

  it('testsToRun selects tests across the impact set', async () => {
    const files = {
      'src/a.ts': 'export function base(){return 1;}\nexport function mid(){return base();}\n',
      'test/a.test.ts': "import { mid } from '../src/a';\ntest('mid', () => { mid(); });\n",
    };
    const { graph } = await buildGraph({ root: project(files), generatedAt: PIN, inline: true });
    const base = findNodes(graph, 'base').find((n) => n.kind === 'function')!;
    const ti = testsToRun(graph, base.id);
    expect(ti.affectedTestFiles).toContain('test/a.test.ts');
  });
});

describe('detectRunner', () => {
  it('detects vitest/jest from package.json', () => {
    const root = project({ 'package.json': JSON.stringify({ devDependencies: { vitest: '^2' } }) });
    expect(detectRunner(root).name).toBe('vitest');
  });
  it('detects go test from go.mod', () => {
    const root = project({ 'go.mod': 'module x\ngo 1.21\n' });
    expect(detectRunner(root, 'go').name).toBe('go test');
  });
});

describe('coverage ingestion', () => {
  it('applies LCOV line coverage to nodes', async () => {
    const root = project({
      'src/m.ts': 'export function f(){\n  return 1;\n}\n',
      'coverage/lcov.info': 'SF:src/m.ts\nDA:1,5\nDA:2,5\nDA:3,0\nend_of_record\n',
    });
    const { graph } = await buildGraph({ root, generatedAt: PIN, inline: true });
    const f = (await import('../src/engine/lookup.js')).findNodes(graph, 'f').find((n) => n.kind === 'function')!;
    expect(typeof f.coverage).toBe('number');
    expect(f.tested).toBe(true);
    void fs;
    void path;
  });
});
