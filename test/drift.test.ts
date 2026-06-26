import { describe, it, expect, afterEach } from 'vitest';
import { inventory } from '../src/engine/drift.js';
import { makeProject, cleanup } from './helpers.js';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) cleanup(dirs.pop()!);
});
function project(files: Record<string, string>): string {
  const d = makeProject(files);
  dirs.push(d);
  return d;
}

describe('drift inventory — nested monorepo manifests', () => {
  it('aggregates deps from nested package.json / pyproject / go.mod (not just root)', () => {
    const root = project({
      // no root manifest at all — everything is nested per project
      'web/package.json': JSON.stringify({ dependencies: { react: '^18.0.0' } }),
      'api/package.json': JSON.stringify({ dependencies: { express: '^4.18.0' } }),
      'svc/pyproject.toml': '[project]\ndependencies = ["fastapi>=0.110", "pydantic>=2"]\n',
      'gw/go.mod': 'module gw\n\ngo 1.22\n\nrequire github.com/gin-gonic/gin v1.9.1\n',
    });
    const inv = inventory(root);
    const names = inv.records.map((r) => r.name);
    expect(names).toContain('react');
    expect(names).toContain('express');
    expect(names).toContain('fastapi');
    expect(names).toContain('pydantic');
    expect(names.some((n) => n.includes('gin'))).toBe(true);
    expect(inv.counts).toMatchObject({ npm: 2, pypi: 2, go: 1, total: 5 });
  });

  it('dedupes a dependency shared across sub-projects (counts once)', () => {
    const root = project({
      'a/package.json': JSON.stringify({ dependencies: { lodash: '^4.0.0' } }),
      'b/package.json': JSON.stringify({ dependencies: { lodash: '^4.0.0', zod: '^3.0.0' } }),
    });
    const inv = inventory(root);
    expect(inv.counts.npm).toBe(2); // lodash + zod, lodash not double-counted
    expect(inv.records.filter((r) => r.name === 'lodash')).toHaveLength(1);
  });

  it('does not descend into node_modules', () => {
    const root = project({
      'package.json': JSON.stringify({ dependencies: { react: '^18.0.0' } }),
      'node_modules/evil/package.json': JSON.stringify({ dependencies: { malware: '*' } }),
    });
    const inv = inventory(root);
    expect(inv.records.map((r) => r.name)).toContain('react');
    expect(inv.records.map((r) => r.name)).not.toContain('malware');
  });

  it('resolves the installed npm version from the nearest node_modules', () => {
    const root = project({
      'pkg/package.json': JSON.stringify({ dependencies: { leftpad: '^1.0.0' } }),
      'pkg/node_modules/leftpad/package.json': JSON.stringify({ name: 'leftpad', version: '1.3.0' }),
    });
    const inv = inventory(root);
    expect(inv.records.find((r) => r.name === 'leftpad')?.installed).toBe('1.3.0');
  });
});
