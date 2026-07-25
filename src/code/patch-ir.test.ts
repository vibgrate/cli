import { describe, it, expect } from 'vitest';
import {
  codeEditsToPatchIR,
  patchIRToCodeEdits,
  validatePatchIR,
  PATCH_IR_SCHEMA_VERSION,
  type PatchIR,
} from './patch-ir.js';
import type { CodeEdit } from './types.js';

describe('PatchIR', () => {
  it('lifts CodeEdit replace/create/delete into patch-ir/0', () => {
    const edits: CodeEdit[] = [
      { op: 'replace', file: 'src/a.ts', search: 'old', replace: 'new', anchorSymbol: 'foo' },
      { op: 'create', file: 'src/b.ts', content: 'export {}' },
      { op: 'delete', file: 'src/c.ts' },
    ];
    const patch = codeEditsToPatchIR(edits, { modelId: 'mock', format: 'search-replace' });
    expect(patch.schemaVersion).toBe(PATCH_IR_SCHEMA_VERSION);
    expect(patch.operations).toHaveLength(3);
    expect(patch.operations[0]).toMatchObject({ op: 'replace-text', file: 'src/a.ts', anchorSymbol: 'foo' });
    expect(patch.operations[1]).toMatchObject({ op: 'create-file', file: 'src/b.ts' });
    expect(patch.operations[2]).toMatchObject({ op: 'delete-file', file: 'src/c.ts' });
    expect(validatePatchIR(patch).ok).toBe(true);
  });

  it('round-trips supported ops back to CodeEdit', () => {
    const edits: CodeEdit[] = [
      { op: 'replace', file: 'x.ts', search: 'a', replace: 'b' },
      { op: 'create', file: 'y.ts', content: 'c' },
      { op: 'delete', file: 'z.ts' },
    ];
    const back = patchIRToCodeEdits(codeEditsToPatchIR(edits));
    expect(back).toEqual(edits);
  });

  it('rejects empty operations and bad replace-range bounds', () => {
    const empty: PatchIR = {
      schemaVersion: PATCH_IR_SCHEMA_VERSION,
      operations: [],
      assumptions: [],
      requestedVerification: [],
      provenance: { format: 'structured-json' },
    };
    expect(validatePatchIR(empty).ok).toBe(false);

    const badRange: PatchIR = {
      schemaVersion: PATCH_IR_SCHEMA_VERSION,
      operations: [{ op: 'replace-range', file: 'a.ts', start: 5, end: 2, replacement: 'x' }],
      assumptions: [],
      requestedVerification: [],
      provenance: { format: 'structured-json' },
    };
    const result = validatePatchIR(badRange);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('end must be >= start'))).toBe(true);
  });

  it('is deterministic for the same edits', () => {
    const edits: CodeEdit[] = [{ op: 'replace', file: 'a.ts', search: '1', replace: '2' }];
    expect(codeEditsToPatchIR(edits)).toEqual(codeEditsToPatchIR(edits));
  });
});
