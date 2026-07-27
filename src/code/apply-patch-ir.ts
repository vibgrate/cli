/**
 * Deterministic PatchIR apply engine (Fusion Runtime Phase 4).
 *
 * Validates structure + assumptions, then applies every operation against an
 * in-memory working copy. Either all ops that can apply are threaded in order
 * (best-effort, like applyEdits), or callers use `transactional: true` to
 * require every op to succeed before any file state is returned as "commit".
 *
 * No disk I/O — pure over injectables. Agent tools write only after approval.
 */

import { applyEdit, type SymbolSpan } from './apply.js';
import { hashString } from '../engine/hash.js';
import {
  patchIRToCodeEdits,
  validatePatchIR,
  type PatchAssumption,
  type PatchIR,
  type PatchOperation,
} from './patch-ir.js';
import type { CodeEdit, EditOutcome } from './types.js';

export interface SymbolLocator {
  id: string;
  file: string;
  /** 1-based inclusive line range. */
  start: number;
  end: number;
}

export interface ApplyPatchIROptions {
  readFile: (relativePath: string) => string | null;
  /** Graph symbol spans by file path (for replace-text anchors). */
  spansForFile?: (file: string) => SymbolSpan[];
  /** Resolve replace-symbol by graph node id. */
  locateSymbol?: (symbolId: string) => SymbolLocator | null;
  /**
   * When true, if any op fails (not applied / no-op that was required), return
   * ok:false and the pre-patch file snapshot (no partial commit view).
   * Default false: thread partial applies like applyEdits.
   */
  transactional?: boolean;
}

export interface ApplyPatchIROpResult {
  index: number;
  op: PatchOperation['op'];
  file: string;
  status: EditOutcome['status'] | 'assumption-failed' | 'unsupported';
  reason?: string;
}

export interface ApplyPatchIRResult {
  ok: boolean;
  /** Per-file before/after after applying (null after = deleted). */
  files: Map<string, { before: string | null; after: string | null }>;
  ops: ApplyPatchIROpResult[];
  errors: string[];
}

/**
 * Apply a validated PatchIR. Runs structural validation first; failed validation
 * returns ok:false with no file mutations in the result map.
 */
export function applyPatchIR(patch: PatchIR, options: ApplyPatchIROptions): ApplyPatchIRResult {
  const structural = validatePatchIR(patch);
  if (!structural.ok) {
    return { ok: false, files: new Map(), ops: [], errors: structural.errors };
  }

  const spansForFile = options.spansForFile ?? (() => []);
  const locateSymbol = options.locateSymbol ?? (() => null);
  const working = new Map<string, string | null>();
  const befores = new Map<string, string | null>();
  const ops: ApplyPatchIROpResult[] = [];
  const errors: string[] = [];

  const read = (file: string): string | null => {
    if (working.has(file)) return working.get(file)!;
    const before = options.readFile(file);
    befores.set(file, before);
    working.set(file, before);
    return before;
  };
  const write = (file: string, content: string | null): void => {
    if (!befores.has(file)) befores.set(file, options.readFile(file));
    working.set(file, content);
  };

  // Assumptions against the pre-patch snapshot (not intermediate working state).
  for (const assumption of patch.assumptions) {
    const check = checkAssumption(assumption, (f) => options.readFile(f), locateSymbol);
    if (!check.ok) {
      errors.push(check.reason ?? 'assumption failed');
      ops.push({
        index: -1,
        op: 'replace-text',
        file: assumption.file ?? '',
        status: 'assumption-failed',
        reason: check.reason,
      });
      if (options.transactional) {
        return { ok: false, files: new Map(), ops, errors };
      }
    }
  }
  if (options.transactional && errors.length) {
    return { ok: false, files: new Map(), ops, errors };
  }

  // Preview pass for transactional mode: apply on a copy, require all applied.
  if (options.transactional) {
    const preview = applyAll(patch.operations, read, write, spansForFile, locateSymbol, ops);
    const failed = preview.some((o) => o.status !== 'applied' && o.status !== 'no-op');
    if (failed) {
      const failErrors = preview.filter((o) => o.status !== 'applied' && o.status !== 'no-op').map((o) => o.reason ?? o.status);
      return { ok: false, files: new Map(), ops: preview, errors: failErrors };
    }
  } else {
    applyAll(patch.operations, read, write, spansForFile, locateSymbol, ops);
  }

  const files = new Map<string, { before: string | null; after: string | null }>();
  for (const [file, after] of working) {
    files.set(file, { before: befores.get(file) ?? null, after });
  }

  const hardFail = ops.some((o) => o.status === 'assumption-failed' || o.status === 'unsupported' || o.status === 'invalid' || o.status === 'not-found' || o.status === 'ambiguous' || o.status === 'conflict');
  return {
    ok: !hardFail && errors.length === 0,
    files,
    ops,
    errors,
  };
}

function applyAll(
  operations: PatchOperation[],
  read: (f: string) => string | null,
  write: (f: string, c: string | null) => void,
  spansForFile: (file: string) => SymbolSpan[],
  locateSymbol: (id: string) => SymbolLocator | null,
  ops: ApplyPatchIROpResult[],
): ApplyPatchIROpResult[] {
  // Clear ops if reusing (transactional preview starts empty).
  const out = ops;
  out.length = 0;

  for (let i = 0; i < operations.length; i++) {
    const op = operations[i];
    const result = applyOne(op, i, read, write, spansForFile, locateSymbol);
    out.push(result);
  }
  return out;
}

function applyOne(
  op: PatchOperation,
  index: number,
  read: (f: string) => string | null,
  write: (f: string, c: string | null) => void,
  spansForFile: (file: string) => SymbolSpan[],
  locateSymbol: (id: string) => SymbolLocator | null,
): ApplyPatchIROpResult {
  if (op.op === 'replace-text' || op.op === 'create-file' || op.op === 'delete-file') {
    const edits = patchIRToCodeEdits({
      schemaVersion: 'patch-ir/0',
      operations: [op],
      assumptions: [],
      requestedVerification: [],
      provenance: { format: 'code-edit' },
    });
    const edit = edits[0] as CodeEdit;
    const file = edit.file;
    const before = read(file);
    const { content, outcome } = applyEdit(before, edit, spansForFile(file));
    if (outcome.status === 'applied' || outcome.status === 'no-op') {
      write(file, content);
    }
    return { index, op: op.op, file, status: outcome.status, reason: outcome.reason };
  }

  if (op.op === 'replace-range') {
    const file = op.file;
    const before = read(file);
    if (before === null) {
      return { index, op: op.op, file, status: 'not-found', reason: `${file} does not exist` };
    }
    if (op.expectedHash) {
      const h = hashString(before);
      if (h !== op.expectedHash) {
        return { index, op: op.op, file, status: 'conflict', reason: `file hash mismatch for ${file} (stale capsule or concurrent edit)` };
      }
    }
    const lines = before.split('\n');
    if (op.start < 1 || op.end > lines.length || op.end < op.start) {
      return { index, op: op.op, file, status: 'invalid', reason: `replace-range ${op.start}-${op.end} outside file (${lines.length} lines)` };
    }
    const next = [...lines.slice(0, op.start - 1), ...op.replacement.split('\n'), ...lines.slice(op.end)].join('\n');
    write(file, next);
    return { index, op: op.op, file, status: next === before ? 'no-op' : 'applied' };
  }

  if (op.op === 'replace-symbol') {
    const loc = locateSymbol(op.symbolId);
    if (!loc) {
      return { index, op: op.op, file: op.file ?? '', status: 'not-found', reason: `symbol ${op.symbolId} not in the map` };
    }
    const file = op.file?.trim() ? op.file : loc.file;
    if (normalize(file) !== normalize(loc.file)) {
      return { index, op: op.op, file, status: 'conflict', reason: `symbol ${op.symbolId} lives in ${loc.file}, not ${file}` };
    }
    const rangeOp: PatchOperation = {
      op: 'replace-range',
      file: loc.file,
      start: loc.start,
      end: loc.end,
      replacement: op.replacement,
      expectedHash: op.expectedHash,
      anchorSymbol: op.symbolId,
    };
    return applyOne(rangeOp, index, read, write, spansForFile, locateSymbol);
  }

  return { index, op: (op as PatchOperation).op, file: '', status: 'unsupported', reason: 'unknown operation' };
}

function checkAssumption(
  a: PatchAssumption,
  readFile: (f: string) => string | null,
  locateSymbol: (id: string) => SymbolLocator | null,
): { ok: boolean; reason?: string } {
  switch (a.kind) {
    case 'file-hash': {
      if (!a.file || !a.expectedHash) return { ok: false, reason: 'file-hash assumption needs file and expectedHash' };
      const content = readFile(a.file);
      if (content === null) return { ok: false, reason: `assumption file-hash: ${a.file} missing` };
      if (hashString(content) !== a.expectedHash) return { ok: false, reason: `assumption file-hash failed for ${a.file}` };
      return { ok: true };
    }
    case 'text-present': {
      if (!a.file || !a.detail) return { ok: false, reason: 'text-present assumption needs file and detail' };
      const content = readFile(a.file);
      if (content === null || !content.includes(a.detail)) {
        return { ok: false, reason: `assumption text-present failed for ${a.file}` };
      }
      return { ok: true };
    }
    case 'symbol-exists': {
      if (!a.symbolId) return { ok: false, reason: 'symbol-exists assumption needs symbolId' };
      if (!locateSymbol(a.symbolId)) return { ok: false, reason: `assumption symbol-exists failed: ${a.symbolId}` };
      return { ok: true };
    }
    case 'symbol-span': {
      if (!a.symbolId) return { ok: false, reason: 'symbol-span assumption needs symbolId' };
      const loc = locateSymbol(a.symbolId);
      if (!loc) return { ok: false, reason: `assumption symbol-span: ${a.symbolId} missing` };
      if (a.file && normalize(a.file) !== normalize(loc.file)) {
        return { ok: false, reason: `assumption symbol-span file mismatch for ${a.symbolId}` };
      }
      return { ok: true };
    }
    case 'other':
      return { ok: true };
    default:
      return { ok: false, reason: `unknown assumption kind: ${String((a as PatchAssumption).kind)}` };
  }
}

function normalize(file: string): string {
  return file.replace(/\\/g, '/').replace(/^\.\//, '');
}

/** Build a symbol locator map from graph nodes (id → span). */
export function locatorsFromGraph(nodes: Array<{ id: string; file: string; span: { start: number; end: number } }>): (symbolId: string) => SymbolLocator | null {
  const map = new Map<string, SymbolLocator>();
  for (const n of nodes) {
    map.set(n.id, { id: n.id, file: normalize(n.file), start: n.span.start, end: n.span.end });
  }
  return (id) => map.get(id) ?? null;
}
