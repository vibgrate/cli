import { describe, it, expect } from 'vitest';
import { parseSource } from '../src/engine/parse.js';

describe('parse — TypeScript', () => {
  it('extracts functions, classes, methods, calls, imports, heritage', async () => {
    const src = [
      "import { double } from './math';",
      'export class A {',
      '  m(): void { double(1); }',
      '}',
      'export class B extends A {}',
      'function top() { return new A(); }',
    ].join('\n');
    const p = await parseSource('a.ts', 'ts', src);

    const names = p.defs.map((d) => d.qualifiedName).sort();
    expect(names).toContain('A');
    expect(names).toContain('A.m');
    expect(names).toContain('B');
    expect(names).toContain('top');

    expect(p.calls.map((c) => c.callee)).toContain('double');
    expect(p.imports.map((i) => i.source)).toContain('./math');
    expect(p.heritage).toEqual(
      expect.arrayContaining([expect.objectContaining({ superName: 'A', kind: 'extends' })]),
    );
  });

  it('computes nested qualified names', async () => {
    const p = await parseSource('a.ts', 'ts', 'class Outer { inner(): void {} }');
    expect(p.defs.map((d) => d.qualifiedName)).toContain('Outer.inner');
  });

  it('is deterministic for the same source', async () => {
    const src = 'export function f(){ return g(); } function g(){ return 1; }';
    const a = await parseSource('a.ts', 'ts', src);
    const b = await parseSource('a.ts', 'ts', src);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('parse — Python', () => {
  it('extracts classes, functions, calls, imports', async () => {
    const src = ['import os', 'class C:', '    def run(self):', '        return helper()', 'def helper():', '    return os.getpid()'].join('\n');
    const p = await parseSource('a.py', 'py', src);
    expect(p.defs.map((d) => d.qualifiedName)).toContain('C.run');
    expect(p.defs.map((d) => d.qualifiedName)).toContain('helper');
    expect(p.calls.map((c) => c.callee)).toContain('helper');
    expect(p.imports.map((i) => i.source)).toContain('os');
  });

  it('trims a multi-line signature at the terminating colon (not the docstring)', async () => {
    const src = [
      'def make_token(',
      '    subject: str | int,',
      '    expires: int | None = None,',
      ') -> str:',
      '    """Create a JWT."""',
      '    return "x"',
    ].join('\n');
    const p = await parseSource('a.py', 'py', src);
    const sig = p.defs.find((d) => d.name === 'make_token')?.signature ?? '';
    expect(sig).toContain('-> str');
    expect(sig).not.toContain('JWT'); // docstring excluded
    expect(sig).not.toContain('"""');
  });
});

describe('parse — Go', () => {
  it('extracts functions and calls', async () => {
    const src = ['package main', 'func add(a int, b int) int { return a + b }', 'func main() { add(1, 2) }'].join('\n');
    const p = await parseSource('a.go', 'go', src);
    expect(p.defs.map((d) => d.name)).toEqual(expect.arrayContaining(['add', 'main']));
    expect(p.calls.map((c) => c.callee)).toContain('add');
  });
});
