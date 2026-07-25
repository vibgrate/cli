import { describe, it, expect } from 'vitest';
import { SessionOverlay } from './overlay.js';
import type { CodeFs } from './session.js';

function memFs(seed: Record<string, string> = {}): CodeFs & { files: Record<string, string | null>; audits: string[] } {
  const files: Record<string, string | null> = { ...seed };
  const audits: string[] = [];
  return {
    files,
    audits,
    read: (f) => (f in files ? files[f] : null),
    write: (f, c) => {
      files[f] = c;
    },
    remove: (f) => {
      files[f] = null;
    },
    appendAudit: (line) => audits.push(line),
  };
}

describe('SessionOverlay', () => {
  it('reads through to base until a dirty write', () => {
    const base = memFs({ 'a.ts': 'one' });
    const o = new SessionOverlay(base);
    expect(o.read('a.ts')).toBe('one');
    o.write('a.ts', 'two');
    expect(o.read('a.ts')).toBe('two');
    expect(base.files['a.ts']).toBe('one');
  });

  it('delete hides the base file until flush', () => {
    const base = memFs({ 'a.ts': 'x' });
    const o = new SessionOverlay(base);
    o.remove('a.ts');
    expect(o.read('a.ts')).toBeNull();
    expect(base.files['a.ts']).toBe('x');
    o.flush();
    expect(base.files['a.ts']).toBeNull();
    expect(o.isDirty()).toBe(false);
  });

  it('flush commits all dirty paths and discard drops them', () => {
    const base = memFs({ 'a.ts': 'a' });
    const o = new SessionOverlay(base);
    o.write('a.ts', 'A');
    o.write('b.ts', 'B');
    expect(o.dirtyFiles()).toEqual(['a.ts', 'b.ts']);
    o.discard();
    expect(o.isDirty()).toBe(false);
    expect(base.files['a.ts']).toBe('a');
    o.write('b.ts', 'B');
    expect(o.flush()).toEqual(['b.ts']);
    expect(base.files['b.ts']).toBe('B');
  });

  it('forwards audit lines immediately', () => {
    const base = memFs();
    const o = new SessionOverlay(base);
    o.appendAudit('{"x":1}');
    expect(base.audits).toEqual(['{"x":1}']);
  });
});
