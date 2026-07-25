/**
 * PatchIR — validated intermediate representation for model-proposed edits
 * (Fusion Runtime Phase 0 / 4).
 *
 * Every model-native format (search/replace blocks, whole-file create/delete,
 * future grammar-constrained JSON) normalizes here before the deterministic
 * apply engine runs. Assumptions let the engine reject stale or hallucinated
 * spans before any write.
 *
 * Schema: docs/fusion/patch-ir-v0.schema.json
 */

import type { CodeEdit } from './types.js';

export const PATCH_IR_SCHEMA_VERSION = 'patch-ir/0' as const;

export type PatchFormat =
  | 'search-replace'
  | 'whole-file'
  | 'structured-json'
  | 'grammar-constrained'
  | 'code-edit';

export type PatchOperation =
  | {
      op: 'replace-range';
      file: string;
      start: number;
      end: number;
      replacement: string;
      expectedHash?: string | null;
      anchorSymbol?: string | null;
    }
  | {
      op: 'replace-text';
      file: string;
      search: string;
      replace: string;
      anchorSymbol?: string | null;
    }
  | {
      op: 'create-file';
      file: string;
      content: string;
    }
  | {
      op: 'delete-file';
      file: string;
    }
  | {
      op: 'replace-symbol';
      symbolId: string;
      file?: string | null;
      replacement: string;
      expectedHash?: string | null;
    };

export interface PatchAssumption {
  kind: 'file-hash' | 'symbol-span' | 'symbol-exists' | 'text-present' | 'other';
  detail: string;
  file?: string | null;
  symbolId?: string | null;
  expectedHash?: string | null;
}

export interface VerificationTarget {
  kind: 'syntax' | 'typecheck' | 'test' | 'build' | 'command';
  target: string;
}

export interface PatchIR {
  schemaVersion: typeof PATCH_IR_SCHEMA_VERSION;
  operations: PatchOperation[];
  assumptions: PatchAssumption[];
  requestedVerification: VerificationTarget[];
  provenance: {
    modelId?: string | null;
    format: PatchFormat;
    raw?: string | null;
  };
}

export interface PatchIRValidation {
  ok: boolean;
  errors: string[];
}

/** Lift existing {@link CodeEdit} values (from parseEdits) into PatchIR. */
export function codeEditsToPatchIR(
  edits: CodeEdit[],
  options: { modelId?: string | null; raw?: string | null; format?: PatchFormat } = {},
): PatchIR {
  const operations: PatchOperation[] = edits.map((edit): PatchOperation => {
    if (edit.op === 'replace') {
      return {
        op: 'replace-text',
        file: normalizeFile(edit.file),
        search: edit.search,
        replace: edit.replace,
        anchorSymbol: edit.anchorSymbol ?? null,
      };
    }
    if (edit.op === 'create') {
      return { op: 'create-file', file: normalizeFile(edit.file), content: edit.content };
    }
    return { op: 'delete-file', file: normalizeFile(edit.file) };
  });

  return {
    schemaVersion: PATCH_IR_SCHEMA_VERSION,
    operations,
    assumptions: [],
    requestedVerification: [],
    provenance: {
      modelId: options.modelId ?? null,
      format: options.format ?? 'code-edit',
      raw: options.raw ?? null,
    },
  };
}

/** Lower PatchIR ops that the current apply engine understands back to CodeEdit. */
export function patchIRToCodeEdits(patch: PatchIR): CodeEdit[] {
  const out: CodeEdit[] = [];
  for (const op of patch.operations) {
    if (op.op === 'replace-text') {
      out.push({
        op: 'replace',
        file: op.file,
        search: op.search,
        replace: op.replace,
        anchorSymbol: op.anchorSymbol ?? undefined,
      });
      continue;
    }
    if (op.op === 'create-file') {
      out.push({ op: 'create', file: op.file, content: op.content });
      continue;
    }
    if (op.op === 'delete-file') {
      out.push({ op: 'delete', file: op.file });
      continue;
    }
    // replace-range / replace-symbol need the full PatchIR engine (Phase 4).
  }
  return out;
}

/**
 * Structural validation only — no filesystem I/O. Rejects empty patches and
 * ops missing required fields so callers fail closed before apply.
 */
export function validatePatchIR(patch: PatchIR): PatchIRValidation {
  const errors: string[] = [];
  if (patch.schemaVersion !== PATCH_IR_SCHEMA_VERSION) {
    errors.push(`unsupported schemaVersion: ${String(patch.schemaVersion)}`);
  }
  if (!Array.isArray(patch.operations) || patch.operations.length === 0) {
    errors.push('operations must be a non-empty array');
  } else {
    patch.operations.forEach((op, i) => {
      if (!op || typeof op !== 'object' || !('op' in op)) {
        errors.push(`operations[${i}]: missing op`);
        return;
      }
      switch (op.op) {
        case 'replace-text':
          if (!op.file?.trim()) errors.push(`operations[${i}]: replace-text requires file`);
          if (typeof op.search !== 'string') errors.push(`operations[${i}]: replace-text requires search`);
          if (typeof op.replace !== 'string') errors.push(`operations[${i}]: replace-text requires replace`);
          break;
        case 'replace-range':
          if (!op.file?.trim()) errors.push(`operations[${i}]: replace-range requires file`);
          if (!Number.isInteger(op.start) || op.start < 1) errors.push(`operations[${i}]: replace-range start must be >= 1`);
          if (!Number.isInteger(op.end) || op.end < op.start) errors.push(`operations[${i}]: replace-range end must be >= start`);
          if (typeof op.replacement !== 'string') errors.push(`operations[${i}]: replace-range requires replacement`);
          break;
        case 'create-file':
          if (!op.file?.trim()) errors.push(`operations[${i}]: create-file requires file`);
          if (typeof op.content !== 'string') errors.push(`operations[${i}]: create-file requires content`);
          break;
        case 'delete-file':
          if (!op.file?.trim()) errors.push(`operations[${i}]: delete-file requires file`);
          break;
        case 'replace-symbol':
          if (!op.symbolId?.trim()) errors.push(`operations[${i}]: replace-symbol requires symbolId`);
          if (typeof op.replacement !== 'string') errors.push(`operations[${i}]: replace-symbol requires replacement`);
          break;
        default:
          errors.push(`operations[${i}]: unknown op`);
      }
    });
  }
  return { ok: errors.length === 0, errors };
}

function normalizeFile(file: string): string {
  return file.replace(/\\/g, '/').replace(/^\.\//, '');
}
