/**
 * Failure Capsule (Fusion Runtime Phase 5 / plan §3).
 *
 * After a verification step fails, the agent should receive a focused repair
 * context — not a raw multi-thousand-line log. This module builds a
 * deterministic Failure Capsule: failed step, first causal diagnostic, affected
 * symbols/files, optional source slices, and ranked correction hints.
 *
 * Schema: docs/fusion/failure-capsule-v0.schema.json
 */

import { hashString } from '../engine/hash.js';
import type { TaskCapsule } from './capsule.js';
import type { LadderStepResult } from './verify-ladder.js';

export const FAILURE_CAPSULE_SCHEMA_VERSION = 'failure-capsule/0' as const;
export const FAILURE_CAPSULE_COMPILER_ID = 'vg-failure-capsule/0' as const;

export interface FailureStep {
  type: 'command' | 'syntax' | 'verify' | 'ladder' | 'other';
  command?: string;
  exitCode?: number;
  detail?: string;
}

export interface FailureSymbolRef {
  qualifiedName: string;
  file: string;
  reason?: string;
}

export interface FailureSourceSlice {
  file: string;
  startLine: number;
  endLine: number;
  content: string;
  contentHash: string;
}

export interface FailureCapsule {
  schemaVersion: typeof FAILURE_CAPSULE_SCHEMA_VERSION;
  failedStep: FailureStep;
  /** Truncated, secret-free diagnostic — prefer first causal line over full log. */
  diagnosticExcerpt: string;
  affectedSymbols: FailureSymbolRef[];
  sourceSlices: FailureSourceSlice[];
  previousOpsSummary: string[];
  graphDeltaNote?: string;
  likelyCorrections: string[];
  rendered: string;
  provenance: {
    compiler: string;
    modelId: string | null;
    policyVersion: string | null;
  };
}

export interface BuildFailureCapsuleOptions {
  /** Ladder results that failed (first non-ok non-note preferred). */
  ladderSteps?: LadderStepResult[];
  /** Explicit verify command failure. */
  verify?: { command: string; exitCode: number; stdout: string };
  /** Original task capsule for symbol/source context. */
  capsule?: TaskCapsule | null;
  /** Files the agent already changed this run. */
  changedFiles?: string[];
  /** Optional short summaries of prior patch ops. */
  previousOpsSummary?: string[];
  graphDeltaNote?: string;
  modelId?: string | null;
  policyVersion?: string | null;
  /** Max diagnostic chars (default 2500). */
  maxDiagnostic?: number;
  /** Max source slices (default 6). */
  maxSlices?: number;
}

/**
 * Build a Failure Capsule from a ladder failure and/or verify command failure.
 * Pure and deterministic given the same inputs.
 */
export function buildFailureCapsule(options: BuildFailureCapsuleOptions): FailureCapsule {
  const maxDiag = options.maxDiagnostic ?? 2500;
  const maxSlices = options.maxSlices ?? 6;

  const failed = pickFailedStep(options);
  const diagnosticExcerpt = redactAndTrim(failed.rawDiagnostic, maxDiag);
  const affectedSymbols = collectAffected(options.capsule, options.changedFiles ?? [], diagnosticExcerpt);
  const sourceSlices = pickSourceSlices(options.capsule, affectedSymbols, maxSlices);
  const likelyCorrections = rankCorrections(failed, diagnosticExcerpt, options.changedFiles ?? []);
  const previousOpsSummary = options.previousOpsSummary ?? (options.changedFiles ?? []).map((f) => `touched ${f}`);

  const capsule: FailureCapsule = {
    schemaVersion: FAILURE_CAPSULE_SCHEMA_VERSION,
    failedStep: failed.step,
    diagnosticExcerpt,
    affectedSymbols,
    sourceSlices,
    previousOpsSummary,
    graphDeltaNote: options.graphDeltaNote,
    likelyCorrections,
    rendered: '',
    provenance: {
      compiler: FAILURE_CAPSULE_COMPILER_ID,
      modelId: options.modelId ?? null,
      policyVersion: options.policyVersion ?? null,
    },
  };
  capsule.rendered = renderFailureCapsule(capsule);
  return capsule;
}

/** Project a Failure Capsule into a user/model message. */
export function renderFailureCapsule(fc: FailureCapsule): string {
  const lines: string[] = [
    '## Failure Capsule',
    `Failed step: ${fc.failedStep.type}${fc.failedStep.command ? ` \`${fc.failedStep.command}\`` : ''}${fc.failedStep.exitCode != null ? ` (exit ${fc.failedStep.exitCode})` : ''}`,
    '',
    '### Diagnostic',
    fc.diagnosticExcerpt || '(no output)',
  ];
  if (fc.affectedSymbols.length) {
    lines.push('', '### Affected symbols / files');
    for (const s of fc.affectedSymbols.slice(0, 12)) {
      lines.push(`- ${s.qualifiedName} (${s.file})${s.reason ? ` — ${s.reason}` : ''}`);
    }
  }
  if (fc.sourceSlices.length) {
    lines.push('', '### Relevant source');
    for (const sl of fc.sourceSlices) {
      lines.push(`\`\`\`${sl.file}:${sl.startLine}-${sl.endLine}`, sl.content, '```');
    }
  }
  if (fc.previousOpsSummary.length) {
    lines.push('', '### Prior ops', ...fc.previousOpsSummary.map((o) => `- ${o}`));
  }
  if (fc.likelyCorrections.length) {
    lines.push('', '### Likely corrections', ...fc.likelyCorrections.map((c) => `- ${c}`));
  }
  if (fc.graphDeltaNote) {
    lines.push('', `Graph: ${fc.graphDeltaNote}`);
  }
  return lines.join('\n');
}

// ── internals ──────────────────────────────────────────────────────────────

function pickFailedStep(options: BuildFailureCapsuleOptions): { step: FailureStep; rawDiagnostic: string } {
  if (options.verify && options.verify.exitCode !== 0) {
    return {
      step: {
        type: 'verify',
        command: options.verify.command,
        exitCode: options.verify.exitCode,
      },
      rawDiagnostic: options.verify.stdout || `exit ${options.verify.exitCode}`,
    };
  }
  const fail = (options.ladderSteps ?? []).find((s) => !s.ok && s.step.kind !== 'note');
  if (fail) {
    if (fail.step.kind === 'command') {
      return {
        step: { type: 'command', command: fail.step.command, detail: fail.message },
        rawDiagnostic: fail.message,
      };
    }
    if (fail.step.kind === 'syntax') {
      return {
        step: { type: 'syntax', detail: fail.message },
        rawDiagnostic: fail.message,
      };
    }
    return {
      step: { type: 'ladder', detail: fail.message },
      rawDiagnostic: fail.message,
    };
  }
  return {
    step: { type: 'other', detail: 'verification failed' },
    rawDiagnostic: 'verification failed (no diagnostic detail)',
  };
}

function collectAffected(
  capsule: TaskCapsule | null | undefined,
  changedFiles: string[],
  diagnostic: string,
): FailureSymbolRef[] {
  const out: FailureSymbolRef[] = [];
  const seen = new Set<string>();
  const push = (qualifiedName: string, file: string, reason?: string): void => {
    const key = `${qualifiedName}|${file}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ qualifiedName, file, reason });
  };

  for (const f of changedFiles) {
    push(f, f, 'modified this session');
  }

  if (capsule) {
    for (const p of capsule.primary) {
      if (changedFiles.includes(p.file) || diagnosticIncludes(diagnostic, p.file) || diagnosticIncludes(diagnostic, p.qualifiedName)) {
        push(p.qualifiedName, p.file, 'primary seed');
      }
    }
    for (const p of capsule.supporting) {
      if (changedFiles.includes(p.file) || diagnosticIncludes(diagnostic, p.file)) {
        push(p.qualifiedName, p.file, 'supporting seed');
      }
    }
    // If nothing matched, still surface primaries as repair candidates.
    if (!out.length) {
      for (const p of capsule.primary.slice(0, 6)) push(p.qualifiedName, p.file, 'primary seed');
    }
  }
  return out;
}

function pickSourceSlices(
  capsule: TaskCapsule | null | undefined,
  affected: FailureSymbolRef[],
  maxSlices: number,
): FailureSourceSlice[] {
  if (!capsule?.sourceSlices?.length) return [];
  const files = new Set(affected.map((a) => a.file));
  const preferred = capsule.sourceSlices.filter((s) => files.has(s.file));
  const rest = capsule.sourceSlices.filter((s) => !files.has(s.file));
  const picked = [...preferred, ...rest].slice(0, maxSlices);
  return picked.map((s) => ({
    file: s.file,
    startLine: s.start,
    endLine: s.end,
    content: s.content,
    contentHash: s.contentHash || hashString(s.content),
  }));
}

function rankCorrections(failed: { step: FailureStep; rawDiagnostic: string }, diagnostic: string, changedFiles: string[]): string[] {
  const hints: string[] = [];
  const d = diagnostic.toLowerCase();
  if (failed.step.type === 'syntax') {
    hints.push('Restore missing files or write non-empty content before re-verifying.');
  }
  if (/cannot find module|module not found|enoent/i.test(diagnostic)) {
    hints.push('Check import paths and that new files were created where imports expect them.');
  }
  if (/typeerror|typescript|ts\d{4}/i.test(diagnostic)) {
    hints.push('Fix the reported type error in the touched files; re-run the typecheck command.');
  }
  if (/assert|expect|fail(ed)?/i.test(d) && /test/.test(d)) {
    hints.push('Align the implementation with the failing assertion; avoid changing the test unless the task requires it.');
  }
  if (/syntaxerror|unexpected token|parse error/i.test(diagnostic)) {
    hints.push('Repair syntax around the last edit; re-read the file span before patching again.');
  }
  if (changedFiles.length) {
    hints.push(`Re-read and patch: ${changedFiles.slice(0, 5).join(', ')}.`);
  }
  if (!hints.length) {
    hints.push('Inspect the diagnostic excerpt, re-read the affected files, apply a minimal fix, then verify again.');
  }
  return hints.slice(0, 6);
}

function diagnosticIncludes(diagnostic: string, needle: string): boolean {
  if (!needle) return false;
  return diagnostic.toLowerCase().includes(needle.toLowerCase());
}

function redactAndTrim(raw: string, max: number): string {
  // Lightweight secret redaction for common token shapes (defense-in-depth;
  // providers.ts also redacts model-facing transport errors).
  let s = raw
    .replace(/(api[_-]?key|token|secret|password)\s*[:=]\s*\S+/gi, '$1=[REDACTED]')
    .replace(/\b(sk|ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{8,}\b/g, '[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._\-]+\b/gi, 'Bearer [REDACTED]');
  // Prefer the first error-looking lines when the log is huge.
  if (s.length > max) {
    const lines = s.split('\n');
    const errorish = lines.filter((l) => /error|fail|assert|exception|enoent|cannot/i.test(l));
    const head = (errorish.length ? errorish : lines).slice(0, 40).join('\n');
    s = head.length > max ? head.slice(0, max) + '\n… (truncated)' : head + (lines.length > 40 ? '\n… (truncated)' : '');
  }
  return s.trim();
}
