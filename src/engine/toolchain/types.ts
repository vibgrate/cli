import type { GraphEdge, GraphNode } from '../../schema.js';
import type { DocCategory } from '../docs-ingest.js';

/**
 * Shared contract for toolchain extractors (infrastructure, CI, container and
 * config formats).
 *
 * An extractor is a pure function of `(rel, source)`. Same bytes in → same
 * nodes and edges out, in the same order. It never reads the filesystem, never
 * shells out, and never resolves anything cross-file: cross-file joins are the
 * linker's job (`link.ts`), which runs once over the whole extracted set.
 */

/** A byte-span within the source file, plus the 1-based line range it covers. */
export interface ToolchainSpan {
  /** 1-based start line. */
  start: number;
  /** 1-based end line. */
  end: number;
}

/**
 * A node before it becomes a {@link GraphNode}. Extractors emit these; the
 * framework fills in the id, centrality defaults and the fields every graph
 * node carries, so an extractor cannot accidentally produce an
 * inconsistently-shaped node.
 */
export interface ToolchainNodeDraft {
  kind: GraphNode['kind'];
  /** Short display name (`web`, `build`, `aws_s3_bucket.assets`). */
  name: string;
  /**
   * Stable identity within the file — the value that, with `kind` and the file
   * path, forms the node id. Must not embed line numbers: a node that moves
   * down the file keeps its id (and every edge touching it).
   */
  qualifiedName: string;
  span: ToolchainSpan;
  /** Sub-type tag surfaced to consumers (`terraform.resource`, `k8s.Deployment`). */
  signature?: string;
  /**
   * One-line human summary. Redacted before storage — extractors must never
   * put a secret *value* here, only its name or reference.
   */
  doc?: string;
  /** Baseline importance 0..1; centrality analysis refines it later. */
  importance?: number;
}

/** An edge between two drafts, addressed by their `qualifiedName`s. */
export interface ToolchainEdgeDraft {
  kind: GraphEdge['kind'];
  /** Source node's `qualifiedName` within this file. */
  from: string;
  /** Target node's `qualifiedName` within this file. */
  to: string;
  /**
   * 0..1. Structural extraction from an unambiguous declaration is 1.0;
   * anything inferred is lower and must say so honestly.
   */
  confidence?: number;
}

/** What an extractor returns for one file. */
export interface ToolchainExtraction {
  nodes: ToolchainNodeDraft[];
  edges: ToolchainEdgeDraft[];
  /**
   * Non-fatal problems (unparseable document, unsupported dialect). Surfaced as
   * build warnings; never thrown. A malformed IaC file must degrade to "no
   * structure extracted", never fail the build.
   */
  warnings?: string[];
  /**
   * Facts the cross-domain linker needs that are not themselves nodes or edges.
   * Kept out of the node set so the graph never carries a node for something
   * that turned out not to exist in the corpus.
   */
  linkHints?: {
    /**
     * Dockerfiles only: for each build stage (keyed by the stage node's
     * `qualifiedName`), the candidate repo-relative paths its `COPY`/`ADD`
     * instructions read. Scoped per stage rather than per file so a stage that
     * only copies from an earlier stage gets no source edges.
     */
    copySourcesByStage?: Record<string, string[]>;
  };
}

/** The language/dialect a file was recognised as. */
export type ToolchainFormat =
  | 'terraform'
  | 'kubernetes'
  | 'helm'
  | 'compose'
  | 'dockerfile'
  | 'github-actions'
  | 'gitlab-ci';

export interface ToolchainExtractor {
  format: ToolchainFormat;
  /**
   * Does this extractor handle the file? Receives the path plus the *head* of
   * the file (not the whole thing), so content heuristics — `apiVersion:` +
   * `kind:` for Kubernetes, a `{{ .Values` marker for Helm — stay cheap.
   */
  matches(rel: string, category: DocCategory, head: string): boolean;
  extract(rel: string, source: string): Promise<ToolchainExtraction> | ToolchainExtraction;
}
