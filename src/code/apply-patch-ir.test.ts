import { describe, it, expect } from 'vitest';
import { applyPatchIR, locatorsFromGraph } from './apply-patch-ir.js';
import { PATCH_IR_SCHEMA_VERSION, type PatchIR } from './patch-ir.js';
import { hashString } from '../engine/hash.js';

function patch(ops: PatchIR['operations'], assumptions: PatchIR['assumptions'] = []): PatchIR {
  return {
    schemaVersion: PATCH_IR_SCHEMA_VERSION,
    operations: ops,
    assumptions,
    requestedVerification: [],
    provenance: { format: 'structured-json' },
  };
}

describe('applyPatchIR', () => {
  it('applies replace-text / create / delete via the CodeEdit bridge', () => {
    const files: Record<string, string | null> = {
      'a.ts': 'const x = 1;\n',
      'c.ts': 'gone\n',
    };
    const result = applyPatchIR(
      patch([
        { op: 'replace-text', file: 'a.ts', search: 'const x = 1;', replace: 'const x = 2;' },
        { op: 'create-file', file: 'b.ts', content: 'export {}\n' },
        { op: 'delete-file', file: 'c.ts' },
      ]),
      { readFile: (f) => (f in files ? files[f] : null) },
    );
    expect(result.ok).toBe(true);
    expect(result.files.get('a.ts')?.after).toContain('const x = 2;');
    expect(result.files.get('b.ts')?.after).toBe('export {}\n');
    expect(result.files.get('c.ts')?.after).toBeNull();
  });

  it('applies replace-range by 1-based lines', () => {
    const body = ['line1', 'line2', 'line3', 'line4'].join('\n');
    const result = applyPatchIR(patch([{ op: 'replace-range', file: 'f.ts', start: 2, end: 3, replacement: 'NEW' }]), {
      readFile: (f) => (f === 'f.ts' ? body : null),
    });
    expect(result.ok).toBe(true);
    expect(result.files.get('f.ts')?.after).toBe('line1\nNEW\nline4');
  });

  it('applies replace-symbol via graph locators', () => {
    const body = ['a', 'function foo() {}', 'b'].join('\n');
    const locate = locatorsFromGraph([{ id: 'foo', file: 's.ts', span: { start: 2, end: 2 } }]);
    const result = applyPatchIR(patch([{ op: 'replace-symbol', symbolId: 'foo', replacement: 'function foo() { return 1; }' }]), {
      readFile: (f) => (f === 's.ts' ? body : null),
      locateSymbol: locate,
    });
    expect(result.ok).toBe(true);
    expect(result.files.get('s.ts')?.after).toContain('return 1');
  });

  it('rejects stale file-hash assumptions', () => {
    const body = 'hello';
    const result = applyPatchIR(
      patch([{ op: 'replace-text', file: 'a.ts', search: 'hello', replace: 'hi' }], [{ kind: 'file-hash', detail: 'stale', file: 'a.ts', expectedHash: 'deadbeef' }]),
      { readFile: () => body, transactional: true },
    );
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('file-hash'))).toBe(true);
    expect(result.files.size).toBe(0);
  });

  it('accepts matching file-hash and applies', () => {
    const body = 'hello';
    const result = applyPatchIR(
      patch([{ op: 'replace-text', file: 'a.ts', search: 'hello', replace: 'hi' }], [
        { kind: 'file-hash', detail: 'ok', file: 'a.ts', expectedHash: hashString(body) },
      ]),
      { readFile: () => body, transactional: true },
    );
    expect(result.ok).toBe(true);
    expect(result.files.get('a.ts')?.after).toBe('hi');
  });

  it('transactional mode refuses partial apply on failed op', () => {
    const result = applyPatchIR(
      patch([
        { op: 'replace-text', file: 'a.ts', search: 'x', replace: 'y' },
        { op: 'replace-text', file: 'missing.ts', search: 'a', replace: 'b' },
      ]),
      { readFile: (f) => (f === 'a.ts' ? 'x' : null), transactional: true },
    );
    expect(result.ok).toBe(false);
    expect(result.files.size).toBe(0);
  });

  it('is deterministic', () => {
    const p = patch([{ op: 'replace-text', file: 'a.ts', search: '1', replace: '2' }]);
    const opts = { readFile: () => '1' };
    expect(applyPatchIR(p, opts)).toEqual(applyPatchIR(p, opts));
  });
});
