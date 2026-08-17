import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readIgnores, isActive, ignoreFilePath } from '../src/lsp/ignores.js';

// `.vibgrate/ignore.json` — presentation-only, reviewable, expirable. The
// reader must be unshockable: a missing or corrupt file is an empty set.
describe('readIgnores', () => {
  const tmps: string[] = [];
  const mkroot = (): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-ignore-'));
    tmps.push(dir);
    return dir;
  };
  const write = (root: string, body: unknown): void => {
    fs.mkdirSync(path.join(root, '.vibgrate'), { recursive: true });
    fs.writeFileSync(ignoreFilePath(root), typeof body === 'string' ? body : JSON.stringify(body));
  };
  afterEach(() => {
    while (tmps.length) fs.rmSync(tmps.pop()!, { recursive: true, force: true });
  });

  it('missing file → empty map', () => {
    expect(readIgnores(mkroot()).size).toBe(0);
  });

  it('corrupt file → empty map, no throw', () => {
    const root = mkroot();
    write(root, '{not json');
    expect(readIgnores(root).size).toBe(0);
  });

  it('reads entries keyed by lowercased package, trimming fields', () => {
    const root = mkroot();
    write(root, { version: 1, ignores: [{ package: ' Moment ', reason: ' migration planned Q4 ' }] });
    const m = readIgnores(root);
    expect(m.get('moment')?.reason).toBe('migration planned Q4');
  });

  it('drops expired entries and keeps unexpired ones (inclusive through the named day)', () => {
    const root = mkroot();
    const now = Date.parse('2026-08-15T12:00:00Z');
    write(root, {
      version: 1,
      ignores: [
        { package: 'a', until: '2026-08-14' },
        { package: 'b', until: '2026-08-15' },
        { package: 'c', until: '2027-01-01' },
      ],
    });
    const m = readIgnores(root, now);
    expect(m.has('a')).toBe(false);
    expect(m.has('b')).toBe(true);
    expect(m.has('c')).toBe(true);
  });

  it('entries without a package are skipped; unparseable until stays active (visible in review)', () => {
    const root = mkroot();
    write(root, { version: 1, ignores: [{ reason: 'no pkg' }, { package: 'x', until: 'someday' }] });
    const m = readIgnores(root);
    expect(m.size).toBe(1);
    expect(m.has('x')).toBe(true);
    expect(isActive({ package: 'x', until: 'someday' })).toBe(true);
  });
});
