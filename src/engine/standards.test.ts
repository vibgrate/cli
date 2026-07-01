import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { normalizeStandards, loadStandards, checkStandards, STANDARDS_FILES } from './standards.js';
import type { DepRecord } from './drift.js';

const tmps: string[] = [];
function tmpRoot(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-standards-'));
  tmps.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const dep = (name: string, ecosystem: DepRecord['ecosystem'], installed?: string): DepRecord => ({ name, ecosystem, declared: '*', installed });

describe('normalizeStandards', () => {
  it('accepts { banned: [...] } and a bare array, requires a name', () => {
    const p = normalizeStandards({ banned: [{ name: 'moment', use: 'date-fns', reason: 'bundle size' }, { reason: 'no name' }] });
    expect(p.banned).toHaveLength(1);
    expect(p.banned[0]).toEqual({ name: 'moment', use: 'date-fns', reason: 'bundle size' });
    expect(normalizeStandards([{ name: 'request' }]).banned[0]).toEqual({ name: 'request' });
  });
  it('lowercases ecosystem, dedups by ecosystem+name, drops junk', () => {
    const p = normalizeStandards({ banned: [{ name: 'left-pad', ecosystem: 'NPM' }, { name: 'left-pad', ecosystem: 'npm' }, 'nope', null, 42] });
    expect(p.banned).toEqual([{ name: 'left-pad', ecosystem: 'npm' }]);
  });
  it('empty / malformed input → empty policy', () => {
    expect(normalizeStandards(null).banned).toEqual([]);
    expect(normalizeStandards({}).banned).toEqual([]);
  });
});

describe('loadStandards', () => {
  it('returns null policy + null path when no file exists', () => {
    expect(loadStandards(tmpRoot())).toEqual({ policy: null, path: null });
  });
  it('loads .vibgrate/standards.json', () => {
    const root = tmpRoot();
    fs.mkdirSync(path.join(root, '.vibgrate'));
    fs.writeFileSync(path.join(root, '.vibgrate/standards.json'), JSON.stringify({ banned: [{ name: 'moment', use: 'date-fns' }] }));
    const { policy, path: p } = loadStandards(root);
    expect(policy?.banned[0].name).toBe('moment');
    expect(p).toContain(STANDARDS_FILES[0]);
  });
  it('prefers .vibgrate/standards.json over vibgrate.standards.json', () => {
    const root = tmpRoot();
    fs.mkdirSync(path.join(root, '.vibgrate'));
    fs.writeFileSync(path.join(root, '.vibgrate/standards.json'), JSON.stringify({ banned: [{ name: 'a' }] }));
    fs.writeFileSync(path.join(root, 'vibgrate.standards.json'), JSON.stringify({ banned: [{ name: 'b' }] }));
    expect(loadStandards(root).policy?.banned[0].name).toBe('a');
  });
  it('present-but-malformed JSON → null policy with the path (caller surfaces a usage error)', () => {
    const root = tmpRoot();
    fs.writeFileSync(path.join(root, 'vibgrate.standards.json'), '{ not json');
    const { policy, path: p } = loadStandards(root);
    expect(policy).toBeNull();
    expect(p).toContain('vibgrate.standards.json');
  });
});

describe('checkStandards', () => {
  const policy = {
    banned: [
      { name: 'moment', use: 'date-fns', reason: 'bundle size' },
      { name: 'colors', ecosystem: 'npm', use: 'picocolors' },
    ],
  };
  it('flags banned deps (case-insensitive), carries remediation + installed version', () => {
    const v = checkStandards(policy, [dep('Moment', 'npm', '2.29.4'), dep('react', 'npm')]);
    expect(v).toHaveLength(1);
    expect(v[0]).toEqual({ ecosystem: 'npm', name: 'Moment', installed: '2.29.4', use: 'date-fns', reason: 'bundle size' });
  });
  it('honors the ecosystem scope when set', () => {
    expect(checkStandards(policy, [dep('colors', 'pypi')])).toHaveLength(0); // rule scoped to npm
    expect(checkStandards(policy, [dep('colors', 'npm')])).toHaveLength(1);
  });
  it('unscoped rule matches any ecosystem; sorted, null remediation when omitted', () => {
    const v = checkStandards({ banned: [{ name: 'x' }] }, [dep('x', 'pypi'), dep('x', 'npm')]);
    expect(v.map((r) => r.ecosystem)).toEqual(['npm', 'pypi']); // sorted by ecosystem
    expect(v[0].use).toBeNull();
    expect(v[0].reason).toBeNull();
  });
  it('clean project → no violations', () => {
    expect(checkStandards(policy, [dep('react', 'npm'), dep('vue', 'npm')])).toEqual([]);
  });
});
