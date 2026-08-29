/**
 * `assess_change` — in-loop prevention, before the code is written.
 *
 * `vg review` answers "was that change sound?" after the fact. This answers
 * "would this be sound?" *while* an agent is deciding, which is the only point
 * at which the fix is free. Same graph, same votes, same protected rules — one
 * question asked earlier.
 *
 * **Transport-free by design.** Nothing here imports an MCP type, a Commander
 * type, or anything from `node:process`. The MCP server is a thin adapter over
 * this function, and so is any future hook or editor integration; keeping the
 * logic on this side is what stops three copies of the rules drifting apart.
 *
 * **One tool, not eight.** A consistency scanner exposes a family of
 * fine-grained questions (`get_dominant_pattern`, `check_file_drift`,
 * `find_similar_function`, …) and leaves the agent to orchestrate them. That
 * pushes the judgement into the model, which is exactly what Review's
 * architecture says must not happen. One call returns facts and a verdict the
 * policy owns.
 */

import { classifyRoute } from './auth.js';
import { describePattern, isRegression, type DataAccessPattern } from './dimensions.js';
import type { DominanceVote } from './dominance.js';
import { routesForFile } from './routes.js';
import { isComparable, SimilarityIndex, type FunctionBody } from './similarity.js';

/**
 * Envelope status. A tool must never throw for "no data" — an agent mid-edit
 * cannot recover from an exception, and a hard failure teaches it to stop
 * calling. Degraded states are values.
 */
export type AssessStatus = 'ok' | 'partial' | 'no_baseline';

export interface AssessConflict {
  kind: 'peer_deviation' | 'unguarded_route' | 'boundary_bypass';
  severity: 'high' | 'medium';
  message: string;
  /** Files worth opening before deciding. */
  referenceFiles: string[];
  /** True when this maps to a protected rule — it cannot be waived later. */
  protectedRule: boolean;
}

export interface AssessDuplicate {
  name: string;
  file: string;
  startLine: number;
  score: number;
}

export interface AssessResult {
  status: AssessStatus;
  /** True when nothing below would block or warn. */
  ok: boolean;
  conflicts: AssessConflict[];
  duplicateOf: AssessDuplicate[];
  /** What this file's peers do, when a convention exists. */
  convention: { group: string; pattern: string; share: number; exemplars: string[] } | null;
  /** The architecture the repository declared, if any. */
  declaredTarget: string | null;
  /** Anything the assessment could not establish. Never silently omitted. */
  unknowns: string[];
  /** Calibrated 0..1 confidence in the assessment as a whole. */
  confidence: number;
}

export interface AssessInput {
  /** Repo-relative path the code would live at. */
  file: string;
  /** The proposed body/content. */
  content: string;
  /** Peer votes from the last capsule compile. */
  votes: readonly DominanceVote[];
  /** Every known file's data-access label. */
  dataAccess: ReadonlyMap<string, DataAccessPattern>;
  /** Similarity index over the existing corpus. */
  similarity: SimilarityIndex | null;
  /** The declared target architecture, if any. */
  declaredTarget: string | null;
  /** The peer group this file belongs to, when known. */
  group?: string;
  /** Route classifications for the file's directory, for the guard convention. */
  guardedShare?: { guarded: number; classified: number } | null;
}

/**
 * Assess a proposed change. Never throws.
 *
 * The verdict is `ok` only when nothing was found *and* enough was known to
 * look — an empty result from an empty index is `no_baseline`, not approval.
 * That distinction is the whole reason the status field exists.
 */
export function assessChange(input: AssessInput): AssessResult {
  const conflicts: AssessConflict[] = [];
  const unknowns: string[] = [];

  const haveGraph = input.similarity !== null && input.votes.length > 0;
  if (!haveGraph) {
    unknowns.push('No code map was available — run `vg` to build one so this can compare against the repository.');
  }

  // ── Does it match what its peers do? ────────────────────────────────────
  const vote = input.group
    ? input.votes.find((v) => v.group === input.group)
    : input.votes.find((v) => v.deviators.includes(input.file) || v.exemplars.includes(input.file));

  const convention =
    vote && vote.reason === 'dominant' && vote.dominant
      ? {
          group: vote.group,
          pattern: vote.dominant,
          share: vote.share,
          exemplars: vote.exemplars,
        }
      : null;

  if (vote && vote.reason === 'no_convention') {
    unknowns.push(
      `${vote.group} has no convention — its peers are split, so there is no house style to match. `
        + 'Pick the shape that matches the declared target.',
    );
  }

  // The proposed content's own data-access shape, inferred from what it calls.
  const proposedPattern = inferProposedPattern(input.content, input.dataAccess);
  if (convention && proposedPattern) {
    if (isRegression(proposedPattern, convention.pattern as DataAccessPattern)) {
      conflicts.push({
        kind: 'peer_deviation',
        severity: input.declaredTarget ? 'high' : 'medium',
        message:
          `This ${describePattern(proposedPattern)}, while ${(convention.share * 100).toFixed(0)}% of its `
          + `peers in ${convention.group} ${describePattern(convention.pattern)}.`,
        referenceFiles: convention.exemplars.slice(0, 3),
        protectedRule: false,
      });
    }
  } else if (!convention && proposedPattern === 'direct-persistence') {
    unknowns.push(
      'No peer convention could be established for this file, so reaching persistence directly is '
        + 'neither confirmed as normal here nor flagged as a deviation.',
    );
  }

  // ── Would it add an unguarded route? ────────────────────────────────────
  for (const route of routesForFile(input.file, input.content)) {
    const verdict = classifyRoute(route);
    if (verdict.verdict === 'unsure') {
      unknowns.push(
        `A route in this file could not be classified as guarded or open (${verdict.rule}).`,
      );
      continue;
    }
    if (verdict.verdict !== 'not-auth') continue;
    if (!/^(POST|PUT|PATCH|DELETE|ALL)$/i.test(route.method)) continue;

    const share = input.guardedShare;
    const dominantlyGuarded = share && share.classified > 0 && share.guarded / share.classified >= 0.75;
    if (!dominantlyGuarded) {
      unknowns.push(
        `${route.method} ${route.path || input.file} has no guard, and there are too few classified `
          + 'peer routes to say whether that is the convention here.',
      );
      continue;
    }
    conflicts.push({
      kind: 'unguarded_route',
      severity: 'high',
      message:
        `${route.method} ${route.path || input.file} would have no authorization guard, while `
        + `${share!.guarded} of ${share!.classified} mutating routes alongside it do.`,
      referenceFiles: [],
      // This maps to a protected rule: if it lands, `vg review` cannot pass it.
      protectedRule: true,
    });
  }

  // ── Does it already exist? ──────────────────────────────────────────────
  const duplicateOf: AssessDuplicate[] = [];
  if (input.similarity && isComparable(input.file)) {
    const query: FunctionBody = {
      id: `__proposed__:${input.file}`,
      name: '(proposed)',
      file: input.file,
      startLine: 1,
      endLine: input.content.split('\n').length,
      text: input.content,
    };
    for (const hit of input.similarity.find(query).filter((h) => isComparable(h.file))) {
      duplicateOf.push({ name: hit.name, file: hit.file, startLine: hit.startLine, score: hit.score });
    }
  }

  const status: AssessStatus = !haveGraph ? 'no_baseline' : unknowns.length > 0 ? 'partial' : 'ok';
  return {
    status,
    // `ok` is about the change, not the lookup — a `no_baseline` run with no
    // conflicts is not an endorsement, and the status is what says so.
    ok: conflicts.length === 0 && duplicateOf.length === 0,
    conflicts,
    duplicateOf,
    convention,
    declaredTarget: input.declaredTarget,
    unknowns,
    confidence: confidenceOf(status, convention, conflicts.length),
  };
}

/**
 * Infer the proposed content's data-access shape from the files it imports.
 *
 * Deliberately conservative: it can only see what the text references, so it
 * returns `null` rather than guessing when nothing recognisable is imported.
 */
function inferProposedPattern(
  content: string,
  dataAccess: ReadonlyMap<string, DataAccessPattern>,
): DataAccessPattern | null {
  const imports = [...content.matchAll(/(?:from|import|require)\s*\(?\s*['"]([^'"]+)['"]/g)].map(
    (m) => m[1],
  );
  if (imports.length === 0) return null;

  let sawPersistence = false;
  let sawService = false;
  for (const specifier of imports) {
    const base = specifier.replace(/^.*\//, '').replace(/\.(js|ts|mjs|cjs)$/, '').toLowerCase();
    for (const [path, pattern] of dataAccess) {
      const target = path.replace(/^.*\//, '').replace(/\.[^.]+$/, '').toLowerCase();
      if (target !== base) continue;
      if (pattern === 'direct-persistence' && /repositor|dao|store|entity|model/.test(target)) {
        sawPersistence = true;
      }
      if (/service|usecase|application|handler/.test(target)) sawService = true;
    }
    if (/repositor|dao|persistence|entity/.test(base)) sawPersistence = true;
    if (/service|usecase/.test(base)) sawService = true;
  }

  if (sawPersistence) return 'direct-persistence';
  if (sawService) return 'via-service';
  return null;
}

/** Calibrated confidence: how much did we actually know when we answered? */
function confidenceOf(
  status: AssessStatus,
  convention: AssessResult['convention'],
  conflictCount: number,
): number {
  if (status === 'no_baseline') return 0.2;
  let confidence = status === 'ok' ? 0.8 : 0.6;
  if (convention) confidence += 0.1;
  if (conflictCount === 0 && !convention) confidence -= 0.2;
  return Math.max(0, Math.min(1, Number(confidence.toFixed(2))));
}

/** A compact, agent-readable rendering of the result. */
export function renderAssessment(result: AssessResult): string {
  const lines: string[] = [];
  if (result.conflicts.length === 0 && result.duplicateOf.length === 0) {
    lines.push(
      result.status === 'no_baseline'
        ? 'No code map, so nothing could be checked. This is not an approval — run `vg` to build one.'
        : 'No conflicts with the surrounding code.',
    );
  }
  for (const c of result.conflicts) {
    lines.push(`${c.protectedRule ? '[blocks merge] ' : ''}${c.message}`);
    if (c.referenceFiles.length > 0) lines.push(`  follow: ${c.referenceFiles.join(', ')}`);
  }
  for (const d of result.duplicateOf) {
    lines.push(`Already exists: ${d.name} in ${d.file}:${d.startLine} (${(d.score * 100).toFixed(0)}% match).`);
  }
  if (result.declaredTarget) lines.push(`Declared architecture: ${result.declaredTarget}.`);
  for (const u of result.unknowns) lines.push(`Unknown: ${u}`);
  return lines.join('\n');
}
