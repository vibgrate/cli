// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import type {
  ArchitectureEvidence,
  ArchitectureEvidenceDimension,
  ArchitectureViolation,
  ArchitectureWorkspaceEdge,
} from '../../types.js';
import {
  EVIDENCE_FLOOR,
  EVIDENCE_PAYLOAD_CAP,
  VIOLATIONS_CAP,
  WORKSPACE_EDGES_CAP,
  type ArchitectureKnowledgePack,
  type FusionResult,
  type FusionWinner,
  type ProjectContext,
} from './types.js';

export { EVIDENCE_FLOOR, EVIDENCE_PAYLOAD_CAP, VIOLATIONS_CAP, WORKSPACE_EDGES_CAP };

function compareEvidence(a: ArchitectureEvidence, b: ArchitectureEvidence): number {
  if (b.confidence !== a.confidence) return b.confidence - a.confidence;
  const pack = a.packId.localeCompare(b.packId);
  if (pack !== 0) return pack;
  const dim = a.dimension.localeCompare(b.dimension);
  if (dim !== 0) return dim;
  return a.value.localeCompare(b.value);
}

function compareWinnerTie(a: ArchitectureEvidence, b: ArchitectureEvidence): number {
  const pack = a.packId.localeCompare(b.packId);
  if (pack !== 0) return pack;
  return a.value.localeCompare(b.value);
}

/** Stable-sort signals so identical input → identical JSON. */
export function evidenceOf(
  packId: string,
  dimension: ArchitectureEvidenceDimension,
  value: string,
  confidence: number,
  signals: readonly string[],
): ArchitectureEvidence {
  return {
    packId,
    dimension,
    value,
    confidence,
    signals: [...signals].sort((a, b) => a.localeCompare(b)),
  };
}

/**
 * Collect every Evidence from every pack whose match() is non-empty.
 * A pack never deletes another pack's evidence.
 */
export function collectPackEvidence(
  packs: readonly ArchitectureKnowledgePack[],
  context: ProjectContext,
): { matching: ArchitectureKnowledgePack[]; evidence: ArchitectureEvidence[] } {
  const matching: ArchitectureKnowledgePack[] = [];
  const evidence: ArchitectureEvidence[] = [];
  for (const pack of packs) {
    const hits = pack.match(context);
    if (hits.length === 0) continue;
    matching.push(pack);
    for (const item of hits) evidence.push(item);
  }
  return { matching, evidence };
}

/**
 * Fusion always runs on the uncapped set.
 * Per dimension, keep evidence above the floor; reported value = highest
 * confidence, ties by packId then value (localeCompare).
 */
export function fuseEvidence(evidence: readonly ArchitectureEvidence[]): FusionResult {
  const winners = new Map<ArchitectureEvidenceDimension, FusionWinner>();
  const byDimension = new Map<ArchitectureEvidenceDimension, ArchitectureEvidence[]>();
  for (const item of evidence) {
    const list = byDimension.get(item.dimension);
    if (list) list.push(item);
    else byDimension.set(item.dimension, [item]);
  }
  for (const [dimension, items] of byDimension) {
    const above = items.filter((e) => e.confidence >= EVIDENCE_FLOOR);
    if (above.length === 0) continue;
    let best = above[0]!;
    for (let i = 1; i < above.length; i++) {
      const cand = above[i]!;
      if (cand.confidence > best.confidence || (cand.confidence === best.confidence && compareWinnerTie(cand, best) < 0)) {
        best = cand;
      }
    }
    winners.set(dimension, { value: best.value, confidence: best.confidence, packId: best.packId });
  }
  const packIds = [...new Set(evidence.map((e) => e.packId))].sort((a, b) => a.localeCompare(b));
  return { evidence: [...evidence], winners, packIds };
}

export function capEvidence(evidence: readonly ArchitectureEvidence[]): {
  evidence: ArchitectureEvidence[] | undefined;
  evidenceCapped?: true;
} {
  if (evidence.length === 0) return { evidence: undefined };
  const sorted = [...evidence].sort(compareEvidence);
  if (sorted.length > EVIDENCE_PAYLOAD_CAP) {
    return { evidence: sorted.slice(0, EVIDENCE_PAYLOAD_CAP), evidenceCapped: true };
  }
  return { evidence: sorted };
}

function compareWorkspaceEdge(a: ArchitectureWorkspaceEdge, b: ArchitectureWorkspaceEdge): number {
  if (b.confidence !== a.confidence) return b.confidence - a.confidence;
  const kind = a.kind.localeCompare(b.kind);
  if (kind !== 0) return kind;
  const from = a.fromProject.localeCompare(b.fromProject);
  if (from !== 0) return from;
  const to = a.toProject.localeCompare(b.toProject);
  if (to !== 0) return to;
  const fromFile = (a.fromFile ?? '').localeCompare(b.fromFile ?? '');
  if (fromFile !== 0) return fromFile;
  return (a.toFile ?? '').localeCompare(b.toFile ?? '');
}

export function capWorkspaceEdges(edges: readonly ArchitectureWorkspaceEdge[]): {
  workspaceEdges: ArchitectureWorkspaceEdge[] | undefined;
  workspaceEdgesCapped?: true;
} {
  if (edges.length === 0) return { workspaceEdges: undefined };
  const sorted = [...edges].sort(compareWorkspaceEdge);
  if (sorted.length > WORKSPACE_EDGES_CAP) {
    return { workspaceEdges: sorted.slice(0, WORKSPACE_EDGES_CAP), workspaceEdgesCapped: true };
  }
  return { workspaceEdges: sorted };
}

function compareViolation(a: ArchitectureViolation, b: ArchitectureViolation): number {
  const from = a.fromFile.localeCompare(b.fromFile);
  if (from !== 0) return from;
  const to = a.toFile.localeCompare(b.toFile);
  if (to !== 0) return to;
  return a.rule.localeCompare(b.rule);
}

function violationKey(v: ArchitectureViolation): string {
  return `${v.fromFile}|${v.toFile}|${v.rule}`;
}

/**
 * Stable sort by (fromFile, toFile, rule). Cap 100.
 * Unlike workspace edges, the caller emits `[]` when a graph ran and found
 * nothing — absent is reserved for "no graph".
 */
export function capViolations(violations: readonly ArchitectureViolation[]): {
  violations: ArchitectureViolation[];
  violationsCapped?: true;
} {
  const seen = new Set<string>();
  const unique: ArchitectureViolation[] = [];
  for (const v of violations) {
    const key = violationKey(v);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(v);
  }
  unique.sort(compareViolation);
  if (unique.length > VIOLATIONS_CAP) {
    return { violations: unique.slice(0, VIOLATIONS_CAP), violationsCapped: true };
  }
  return { violations: unique };
}
