/**
 * Task Capsule deltas (Fusion Phase 3 — subsequent-turn context).
 *
 * After mutations, recompile a capsule and emit only what changed so the model
 * does not re-pay for the full first-turn evidence. Pure over two capsules.
 */

import type { CapsuleSymbolRef, SourceSlice, TaskCapsule, VerificationPlan } from './capsule.js';

export const CAPSULE_DELTA_SCHEMA_VERSION = 'capsule-delta/0' as const;

export interface CapsuleDelta {
  schemaVersion: typeof CAPSULE_DELTA_SCHEMA_VERSION;
  /** Files whose source slices changed (content hash). */
  changedSourceFiles: string[];
  /** New primary symbols not in the previous capsule. */
  addedPrimary: Array<{ qualifiedName: string; file: string; kind: string }>;
  /** Primaries that disappeared. */
  removedPrimary: Array<{ qualifiedName: string; file: string }>;
  /** Supporting symbols newly present. */
  addedSupporting: Array<{ qualifiedName: string; file: string; kind: string }>;
  /** Verification plan notes / files that differ. */
  verificationDelta: {
    syntaxFilesAdded: string[];
    syntaxFilesRemoved: string[];
    notesAdded: string[];
  };
  /** Compact human/model-facing summary. */
  rendered: string;
  tokensEstimate: number;
}

/**
 * Diff two capsules. Deterministic given the same pair.
 */
export function buildCapsuleDelta(previous: TaskCapsule, next: TaskCapsule): CapsuleDelta {
  const prevPrimary = keySet(previous.primary);
  const nextPrimary = keySet(next.primary);
  const prevSupport = keySet(previous.supporting);
  const nextSupport = keySet(next.supporting);

  const addedPrimary = next.primary
    .filter((p) => !prevPrimary.has(symKey(p)))
    .map((p) => ({ qualifiedName: p.qualifiedName, file: p.file, kind: p.kind }));
  const removedPrimary = previous.primary
    .filter((p) => !nextPrimary.has(symKey(p)))
    .map((p) => ({ qualifiedName: p.qualifiedName, file: p.file }));
  const addedSupporting = next.supporting
    .filter((p) => !prevSupport.has(symKey(p)))
    .map((p) => ({ qualifiedName: p.qualifiedName, file: p.file, kind: p.kind }));

  const changedSourceFiles = diffSourceFiles(previous.sourceSlices, next.sourceSlices);
  const verificationDelta = diffVerification(previous.verificationPlan, next.verificationPlan);

  const delta: CapsuleDelta = {
    schemaVersion: CAPSULE_DELTA_SCHEMA_VERSION,
    changedSourceFiles,
    addedPrimary,
    removedPrimary,
    addedSupporting,
    verificationDelta,
    rendered: '',
    tokensEstimate: 0,
  };
  delta.rendered = renderCapsuleDelta(delta, next);
  delta.tokensEstimate = Math.max(1, Math.ceil(delta.rendered.length / 4));
  return delta;
}

/** True when the delta is empty (no model update needed). */
export function isEmptyCapsuleDelta(d: CapsuleDelta): boolean {
  return (
    d.changedSourceFiles.length === 0 &&
    d.addedPrimary.length === 0 &&
    d.removedPrimary.length === 0 &&
    d.addedSupporting.length === 0 &&
    d.verificationDelta.syntaxFilesAdded.length === 0 &&
    d.verificationDelta.syntaxFilesRemoved.length === 0 &&
    d.verificationDelta.notesAdded.length === 0
  );
}

function keySet(syms: CapsuleSymbolRef[]): Set<string> {
  return new Set(syms.map(symKey));
}

function symKey(p: { qualifiedName: string; file: string }): string {
  return `${p.qualifiedName}\0${p.file}`;
}

function diffSourceFiles(prev: SourceSlice[], next: SourceSlice[]): string[] {
  const prevHash = new Map<string, string>();
  for (const s of prev) {
    const k = `${s.file}:${s.start}-${s.end}`;
    prevHash.set(k, s.contentHash);
  }
  const changed = new Set<string>();
  for (const s of next) {
    const k = `${s.file}:${s.start}-${s.end}`;
    const old = prevHash.get(k);
    if (old !== s.contentHash) changed.add(s.file);
  }
  // Files that vanished entirely.
  const nextFiles = new Set(next.map((s) => s.file));
  for (const s of prev) {
    if (!nextFiles.has(s.file)) changed.add(s.file);
  }
  return [...changed].sort();
}

function diffVerification(prev: VerificationPlan, next: VerificationPlan): CapsuleDelta['verificationDelta'] {
  const prevFiles = new Set(prev.syntaxFiles);
  const nextFiles = new Set(next.syntaxFiles);
  const prevNotes = new Set(prev.notes);
  return {
    syntaxFilesAdded: next.syntaxFiles.filter((f) => !prevFiles.has(f)).sort(),
    syntaxFilesRemoved: prev.syntaxFiles.filter((f) => !nextFiles.has(f)).sort(),
    notesAdded: next.notes.filter((n) => !prevNotes.has(n)),
  };
}

function renderCapsuleDelta(d: CapsuleDelta, next: TaskCapsule): string {
  const lines: string[] = [
    '## Capsule delta (since last context)',
    `Instruction: ${next.instruction}`,
  ];
  if (d.changedSourceFiles.length) {
    lines.push(`Source updated: ${d.changedSourceFiles.join(', ')}`);
  }
  if (d.addedPrimary.length) {
    lines.push('New primary:');
    for (const p of d.addedPrimary) lines.push(`- ${p.qualifiedName} (${p.kind}) ${p.file}`);
  }
  if (d.removedPrimary.length) {
    lines.push('Removed primary:');
    for (const p of d.removedPrimary) lines.push(`- ${p.qualifiedName} ${p.file}`);
  }
  if (d.addedSupporting.length) {
    lines.push('New supporting:');
    for (const p of d.addedSupporting.slice(0, 8)) lines.push(`- ${p.qualifiedName} ${p.file}`);
  }
  if (d.verificationDelta.syntaxFilesAdded.length || d.verificationDelta.notesAdded.length) {
    lines.push('Verification plan updates:');
    for (const f of d.verificationDelta.syntaxFilesAdded) lines.push(`- +syntax ${f}`);
    for (const n of d.verificationDelta.notesAdded.slice(0, 4)) lines.push(`- +note ${n}`);
  }
  if (isEmptyCapsuleDelta(d)) {
    lines.push('(no structural capsule changes)');
  }
  // Include re-rendered slices for changed files only (bounded).
  const changed = new Set(d.changedSourceFiles);
  const slices = next.sourceSlices.filter((s) => changed.has(s.file)).slice(0, 6);
  if (slices.length) {
    lines.push('', '### Updated source slices');
    for (const s of slices) {
      lines.push(`\`\`\`${s.file}:${s.start}-${s.end}`, s.content, '```');
    }
  }
  return lines.join('\n');
}
