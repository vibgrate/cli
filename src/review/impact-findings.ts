/**
 * Deterministic blast-radius findings for a Review change set.
 *
 * Reuses {@link impactOf} — the same reverse-reachability `vg impact` uses —
 * over the capsule's changed symbols. Findings are `vg.review.findings.v1`
 * rows so {@link proposeFindingFix} can attach a PatchIR proposal without a
 * second agent loop.
 *
 * These are graph facts, not architecture-policy verdicts and not a hosted
 * model. Severity stays at or below `medium` so a blast-radius observation
 * cannot trip the high-severity gate on its own.
 */

import { impactOf, type ImpactItem, type ImpactResult } from '../engine/impact.js';
import { testsToRun } from '../engine/test-query.js';
import type { VgGraph } from '../schema.js';
import { attachVerificationReceipts } from './finding-receipts.js';
import type { AnalysisCapsule, CapsuleChangeSymbol, ReviewFinding } from './schemas.js';

/** Same default depth as `vg impact`. */
export const IMPACT_FINDING_DEPTH = 4;

/** Cap so a wide PR cannot flood the receipt. Ranked by fan-out. */
export const MAX_IMPACT_FINDINGS = 8;

/** Callers named in the claim / evidence (the rest stay in the count). */
const MAX_NAMED_CALLERS = 4;

export interface BlastRadiusScanInput {
  graph: VgGraph;
  capsule: AnalysisCapsule;
  depth?: number;
}

/** Top-level `kind` for blast-radius/impact rows. Not a second kind. */
export const CORRECTNESS_KIND = 'correctness' as const;

/** Pack/producer metadata only — never a second top-level `kind`. */
export const BLAST_PRODUCER = 'blast_radius' as const;

/**
 * Stable `id` used as finding_key. Same symbol/node → same key across
 * runs, rank, and head SHAs. Prefer the graph node id; else path + name.
 * Repo-relative path. No head SHA. No spaces.
 */
export function blastFindingKey(symbol: Pick<CapsuleChangeSymbol, 'node_id' | 'path' | 'name'>): string {
  const nodeId = keyPart(symbol.node_id ?? '');
  if (nodeId) return `blast:${nodeId}`;
  return `blast:${keyPart(normalize(symbol.path))}:${keyPart(symbol.name)}`;
}

/**
 * Emit one finding per changed symbol that has a cross-file dependent.
 * Same-file-only fan-out is not a blast radius a reviewer can act on.
 * Deterministic: symbols and dependents are sorted before emission.
 * `id` is the stable blast key, not a rank-local display id.
 */
export function collectBlastRadiusFindings(input: BlastRadiusScanInput): ReviewFinding[] {
  const { graph, capsule } = input;
  const depth = input.depth ?? IMPACT_FINDING_DEPTH;

  const ranked: RankedImpact[] = [];
  for (const symbol of sortSymbols(capsule.change.symbols)) {
    if (!symbol.node_id) continue;
    if (!graph.nodes.some((n) => n.id === symbol.node_id)) continue;
    const impact = impactOf(graph, symbol.node_id, { depth });
    const crossFile = impact.affected.filter((a) => normalize(a.file) !== normalize(symbol.path));
    if (crossFile.length === 0) continue;
    ranked.push({ symbol, impact, crossFile });
  }

  ranked.sort(compareRanked);

  const findings: ReviewFinding[] = [];
  for (const row of ranked.slice(0, MAX_IMPACT_FINDINGS)) {
    findings.push(toFinding(capsule, graph, row));
  }
  return findings;
}

interface RankedImpact {
  symbol: CapsuleChangeSymbol;
  impact: ImpactResult;
  crossFile: ImpactItem[];
}

function sortSymbols(symbols: CapsuleChangeSymbol[]): CapsuleChangeSymbol[] {
  return [...symbols].sort(
    (a, b) =>
      a.path.localeCompare(b.path) ||
      a.name.localeCompare(b.name) ||
      (a.node_id ?? '').localeCompare(b.node_id ?? ''),
  );
}

function compareRanked(a: RankedImpact, b: RankedImpact): number {
  const aDirect = a.crossFile.filter((x) => x.depth === 1).length;
  const bDirect = b.crossFile.filter((x) => x.depth === 1).length;
  if (bDirect !== aDirect) return bDirect - aDirect;
  if (b.crossFile.length !== a.crossFile.length) return b.crossFile.length - a.crossFile.length;
  return (
    a.symbol.path.localeCompare(b.symbol.path) ||
    a.symbol.name.localeCompare(b.symbol.name) ||
    (a.symbol.node_id ?? '').localeCompare(b.symbol.node_id ?? '')
  );
}

function toFinding(
  capsule: AnalysisCapsule,
  graph: VgGraph,
  row: RankedImpact,
): ReviewFinding {
  const { symbol, crossFile } = row;
  const id = blastFindingKey(symbol);
  const named = crossFile.slice(0, MAX_NAMED_CALLERS);
  const direct = crossFile.filter((a) => a.depth === 1).length;
  const transitive = crossFile.filter((a) => a.depth > 1).length;
  const files = [...new Set(crossFile.map((a) => normalize(a.file)))].sort();
  const callerNames = named.map((a) => `${shortName(a.name)} in ${normalize(a.file)}`);
  const extra = crossFile.length - named.length;

  const evidenceIds = impactEvidence(capsule, symbol, named);
  const untested = capsule.verification.some(
    (v) => v.kind === 'no_test_covering_change' && normalize(v.path) === normalize(symbol.path),
  );

  let coveringTests = 0;
  if (symbol.node_id) {
    coveringTests = testsToRun(graph, symbol.node_id, IMPACT_FINDING_DEPTH).affectedTestFiles.length;
  }

  const more = extra > 0 ? ` (and ${extra} more)` : '';
  const testNote = untested
    ? ' No test edge reaches this file in the map.'
    : coveringTests > 0
      ? ` ${coveringTests} covering test file(s) reach the blast radius.`
      : '';

  return attachVerificationReceipts(
    {
      id,
      kind: CORRECTNESS_KIND,
      finding_key: id,
      producer: BLAST_PRODUCER,
      severity: direct >= 3 ? 'medium' : 'low',
      confidence: confidenceOf(named),
      claim:
        `Changing ${symbol.name} in ${normalize(symbol.path)} reaches ${direct} direct and ${transitive} ` +
        `transitive dependents across ${files.length} file(s): ${callerNames.join(', ') || '(none)'}${more}.` +
        testNote,
      evidence_ids: evidenceIds,
      target_alignment: 'unknown',
      remediation: untested
        ? `Add a test that exercises the highest-fan-out caller (${shortName(named[0]?.name) || symbol.name}) before merging, or keep the exported contract of ${symbol.name} compatible with those callers.`
        : `Keep the exported contract of ${symbol.name} compatible with the listed callers, or extend the covering tests so that contract is locked.`,
      paths: [normalize(symbol.path), ...files].filter((p, i, all) => all.indexOf(p) === i).slice(0, 8),
      protected_finding: false,
      source: 'scanner',
    },
    capsule,
  );
}

function impactEvidence(
  capsule: AnalysisCapsule,
  symbol: CapsuleChangeSymbol,
  callers: ImpactItem[],
): string[] {
  const ids: string[] = [];
  const rootId = `impact:${symbol.node_id ?? symbol.name}`;
  upsertEvidence(capsule, {
    id: rootId,
    kind: 'graph_node',
    path: normalize(symbol.path),
    start_line: symbol.start_line,
    end_line: symbol.end_line,
    protected_finding: false,
    note: `changed ${symbol.kind} ${symbol.name}`,
  });
  ids.push(rootId);
  for (const caller of callers) {
    const id = `impact:${symbol.node_id ?? symbol.name}:dep:${caller.id}`;
    upsertEvidence(capsule, {
      id,
      kind: 'graph_node',
      path: normalize(caller.file),
      start_line: caller.line,
      end_line: caller.line,
      protected_finding: false,
      note: `d${caller.depth} ${caller.name} depends on ${symbol.name}`,
    });
    ids.push(id);
  }
  return ids;
}

function upsertEvidence(
  capsule: AnalysisCapsule,
  evidence: AnalysisCapsule['evidence'][number],
): void {
  if (capsule.evidence.some((e) => e.id === evidence.id)) return;
  capsule.evidence.push(evidence);
}

function confidenceOf(callers: ImpactItem[]): number {
  if (callers.length === 0) return 0.7;
  const min = Math.min(...callers.map((c) => c.confidence));
  // Calibrated below the high-severity gate (0.8) even when every edge is 1.0.
  return Math.min(0.75, Math.max(0.55, Math.round(min * 1e3) / 1e3));
}

function shortName(name: string | undefined): string {
  if (!name) return '';
  const tail = name.split(':').pop() ?? name;
  return tail.split('/').pop() ?? tail;
}

function normalize(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

/** Key fragments: no whitespace (spaces would make the finding_key unstable). */
function keyPart(value: string): string {
  return value.trim().replace(/\s+/g, '');
}
