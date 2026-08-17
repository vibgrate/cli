import * as fs from 'node:fs';
import { edgeId, nodeId } from '../ids.js';
import type { GraphEdge, GraphNode } from '../../schema.js';
import type { DiscoveredDoc } from '../docs-ingest.js';
import { composeExtractor } from './compose.js';
import { dockerfileExtractor } from './dockerfile.js';
import { helmExtractor } from './helm.js';
import { kubernetesExtractor } from './kubernetes.js';
import { terraformExtractor } from './terraform.js';
import { githubActionsExtractor, gitlabCiExtractor } from './workflows.js';
import { linkToolchain } from './link.js';
import { safeDoc, TOOLCHAIN_FILE_MAX_BYTES, toPosix } from './util.js';
import type { ToolchainExtractor, ToolchainFormat, ToolchainNodeDraft } from './types.js';

/**
 * Toolchain extraction — the structural pass over the infrastructure, CI and
 * container corpus.
 *
 * ## Where this sits
 *
 * `docs-ingest.ts` already discovers and classifies exactly these files, and
 * turns each into one truncated `document` node for semantic ask. This module
 * runs over that same discovered set and adds *structure*: resources,
 * workloads, jobs, steps, images, charts, and the edges between them. The
 * document node stays — it is the semantic-ask surface — so nothing regresses.
 *
 * Critically, this does **not** register these files as source code. Adding
 * `.tf`/`.yaml` to `engine/languages.ts` would sweep them into the source
 * corpus, which drives `project-classification.ts` — and that picks the billing
 * tier. Extraction here leaves the source corpus, DriftScore and billing
 * untouched.
 *
 * ## Determinism
 *
 * Extractors are pure over `(rel, source)`. Files are processed in sorted path
 * order, nodes and edges are sorted before return, and ids are content-addressed
 * via the same `nodeId`/`edgeId` helpers the code graph uses. Identical corpus
 * in → byte-identical output.
 */

/**
 * Registered extractors, in match order. Order matters: Helm must win over
 * Kubernetes for a chart's `values.yaml`, and Compose must win over Kubernetes
 * for a `compose.yaml` that happens to contain an `apiVersion` key.
 */
const EXTRACTORS: ToolchainExtractor[] = [
  terraformExtractor,
  dockerfileExtractor,
  githubActionsExtractor,
  gitlabCiExtractor,
  helmExtractor,
  composeExtractor,
  kubernetesExtractor,
];

/** Bytes of a file inspected for content heuristics. */
const HEAD_BYTES = 4096;

export interface ToolchainResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  warnings: string[];
  /** Per-format file counts, for the build summary and `ProjectProfile`. */
  counts: Record<string, number>;
  /** Per-join counts from the cross-domain linker. */
  linkCounts: Record<string, number>;
}

export interface ExtractToolchainOptions {
  /**
   * Repo-relative source path → its `file` node id. Supplied by the build so
   * the cross-domain linker can join a Dockerfile to the files it copies in.
   * Omit to skip that join.
   */
  fileNodes?: ReadonlyMap<string, string>;
}

const EMPTY_RESULT: ToolchainResult = {
  nodes: [],
  edges: [],
  warnings: [],
  counts: {},
  linkCounts: {},
};

/** Every registered format id, sorted. Exported for the profile/report layer. */
export function toolchainFormats(): ToolchainFormat[] {
  return [...new Set(EXTRACTORS.map((e) => e.format))].sort() as ToolchainFormat[];
}

/**
 * Pick the extractor for a discovered file, or null when none applies.
 * Exported so the LSP can answer "is this file structurally understood?"
 * without running a full extraction.
 */
export function extractorFor(doc: DiscoveredDoc, head: string): ToolchainExtractor | null {
  for (const extractor of EXTRACTORS) {
    try {
      if (extractor.matches(toPosix(doc.rel), doc.category ?? doc.kind, head)) return extractor;
    } catch {
      /* a matcher must never break discovery */
    }
  }
  return null;
}

/**
 * Run structural extraction over the discovered document set.
 *
 * Never throws: a malformed manifest, an unreadable file or a missing grammar
 * degrades to a warning and zero structure for that file. Infrastructure files
 * are frequently templated, partial or generated, and a scanner that dies on
 * one of them is a scanner nobody keeps installed.
 */
export async function extractToolchain(
  docs: DiscoveredDoc[],
  options: ExtractToolchainOptions = {},
): Promise<ToolchainResult> {
  if (!docs.length) return EMPTY_RESULT;

  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  const warnings: string[] = [];
  const counts: Record<string, number> = {};
  const stageCopySources = new Map<string, string[]>();

  // Sorted path order keeps the output stable regardless of discovery order.
  const ordered = [...docs].sort((a, b) => toPosix(a.rel).localeCompare(toPosix(b.rel), 'en'));

  for (const doc of ordered) {
    let source: string;
    let head: string;
    try {
      const stat = fs.statSync(doc.abs);
      if (stat.size > TOOLCHAIN_FILE_MAX_BYTES) continue;
      source = fs.readFileSync(doc.abs, 'utf8');
      head = source.slice(0, HEAD_BYTES);
    } catch {
      continue; // unreadable — docs-ingest already tolerates this
    }

    const extractor = extractorFor(doc, head);
    if (!extractor) continue;

    const rel = toPosix(doc.rel);
    let extraction;
    try {
      extraction = await extractor.extract(rel, source);
    } catch (err) {
      warnings.push(`${rel}: ${extractor.format} extraction failed (${(err as Error).message})`);
      continue;
    }

    if (extraction.warnings?.length) warnings.push(...extraction.warnings);
    for (const [stage, paths] of Object.entries(extraction.linkHints?.copySourcesByStage ?? {})) {
      if (paths.length) stageCopySources.set(stage, paths);
    }
    if (!extraction.nodes.length) continue;

    counts[extractor.format] = (counts[extractor.format] ?? 0) + 1;

    // Drafts → graph nodes. `qualifiedName` is scoped by file, so two files
    // declaring `service:web` stay distinct nodes.
    const idByQualifiedName = new Map<string, string>();
    for (const draft of extraction.nodes) {
      const id = nodeId({
        kind: draft.kind,
        qualifiedName: draft.qualifiedName,
        file: rel,
        signature: draft.signature,
      });
      // First declaration of a name in a file wins; a repeat is the same thing.
      if (!idByQualifiedName.has(draft.qualifiedName)) {
        idByQualifiedName.set(draft.qualifiedName, id);
      }
      if (nodes.has(id)) continue;
      nodes.set(id, toGraphNode(id, draft, rel, extractor.format));
    }

    for (const draft of extraction.edges) {
      const src = idByQualifiedName.get(draft.from);
      const dst = idByQualifiedName.get(draft.to);
      // A dangling edge is dropped, never turned into a placeholder node: the
      // graph's value is that it does not invent things it cannot see.
      if (!src || !dst || src === dst) continue;
      const id = edgeId(draft.kind, src, dst);
      if (edges.has(id)) continue;
      edges.set(id, {
        id,
        kind: draft.kind,
        src,
        dst,
        // Structural extraction from a declaration in the file itself.
        resolution: 'heuristic',
        confidence: draft.confidence ?? 1,
        epistemic: 'declared',
      });
    }
  }

  const sortedNodes = [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id, 'en'));
  const sortedEdges = [...edges.values()].sort(byEdgeOrder);

  // Phase 2.1 — join the domains across files. Runs once over the whole set.
  const linked = linkToolchain({
    nodes: sortedNodes,
    edges: sortedEdges,
    fileNodes: options.fileNodes ?? new Map(),
    stageCopySources,
  });

  // A linker edge never overwrites a declared one of the same identity: the
  // declaration is the stronger claim.
  const declaredIds = new Set(sortedEdges.map((e) => e.id));
  const allEdges = [...sortedEdges, ...linked.edges.filter((e) => !declaredIds.has(e.id))].sort(
    byEdgeOrder,
  );

  return {
    nodes: sortedNodes,
    edges: allEdges,
    warnings: [...new Set(warnings)].sort(),
    counts,
    linkCounts: linked.counts,
  };
}

function byEdgeOrder(a: GraphEdge, b: GraphEdge): number {
  return (
    a.kind.localeCompare(b.kind, 'en') ||
    a.src.localeCompare(b.src, 'en') ||
    a.dst.localeCompare(b.dst, 'en')
  );
}

function toGraphNode(
  id: string,
  draft: ToolchainNodeDraft,
  rel: string,
  format: ToolchainFormat,
): GraphNode {
  return {
    id,
    kind: draft.kind,
    name: draft.name,
    qualifiedName: draft.qualifiedName,
    file: rel,
    span: draft.span,
    // `lang` is the format tag, so `--only` and the report can filter on it
    // without colliding with a source language id.
    lang: format,
    signature: draft.signature,
    doc: safeDoc(draft.doc),
    importance: draft.importance ?? 0.3,
    centrality: { degree: 0, pagerank: 0, betweenness: 0, eigenvector: 0 },
    area: -1,
    isHub: false,
    // Infrastructure has no notion of unit-test coverage; `null` is the
    // schema's "not analyzable", which is the honest answer.
    tested: null,
  };
}

export type { ToolchainExtractor, ToolchainFormat } from './types.js';
