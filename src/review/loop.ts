/**
 * `vg review --loop` — explicit review → patch → re-review on the CLI only.
 *
 * Never autoloops. Never writes a git branch. Applies deterministic
 * package.json bumps to the working tree, then reviews again. Caps at three
 * iterations so a patch that does not clear a finding cannot spin.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { patchesFromScanArtifact, patchesFromVersionPairs, type DeterministicPatch } from './patches.js';
import type { RunReviewResult } from './run.js';

export const REVIEW_LOOP_MAX = 3;

export interface LoopStep {
  iteration: number;
  applied: DeterministicPatch[];
  note: string;
}

export interface LoopState {
  steps: LoopStep[];
  exhausted: boolean;
}

export function collectLoopPatches(root: string, result: RunReviewResult): DeterministicPatch[] {
  const fromFindings = patchesFromVersionPairs(
    root,
    [...result.receipt.findings.architecture_findings, ...result.receipt.findings.security_findings].flatMap((f) => {
      const parsed = parseVersionPair(f.claim);
      return parsed ? [parsed] : [];
    }),
  );
  const fromScan = patchesFromScanArtifact(root);
  return dedupe([...fromFindings, ...fromScan]);
}

export function applyPatches(root: string, patches: DeterministicPatch[]): DeterministicPatch[] {
  const applied: DeterministicPatch[] = [];
  for (const patch of patches) {
    const abs = path.join(root, patch.path);
    try {
      const current = fs.readFileSync(abs, 'utf8');
      if (current !== patch.before && current !== patch.after) continue;
      fs.writeFileSync(abs, patch.after, 'utf8');
      applied.push(patch);
    } catch {
      /* leave the file; the next review reports the finding again */
    }
  }
  return applied;
}

export function loopNote(applied: DeterministicPatch[], iteration: number, max = REVIEW_LOOP_MAX): string {
  if (applied.length === 0) {
    return iteration === 1
      ? 'No deterministic patch was available. `--loop` does not invent a fix, and it does not call a hosted model.'
      : 'No further deterministic patch was available.';
  }
  const files = [...new Set(applied.map((p) => p.path))].join(', ');
  return `Applied ${applied.length} deterministic patch(es) to ${files} (iteration ${iteration}/${max}). Refresh the lockfile before you commit.`;
}

function parseVersionPair(claim: string): { packageName: string; fromVersion: string | null; toVersion: string } | null {
  const versions = claim.match(/\((\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\s*→\s*(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\)/);
  if (!versions) return null;
  const name = claim.match(/\b(@?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)?)\b/);
  if (!name) return null;
  return { packageName: name[1] ?? '', fromVersion: versions[1] ?? null, toVersion: versions[2] ?? '' };
}

function dedupe(patches: DeterministicPatch[]): DeterministicPatch[] {
  const seen = new Set<string>();
  const out: DeterministicPatch[] = [];
  for (const patch of patches) {
    const key = `${patch.path}\0${patch.packageName}\0${patch.toVersion}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(patch);
  }
  return out;
}
