import type { CallableEffects } from './engine/effects.js';
import type { Duty } from './engine/duties.js';
/**
 * The `vg-graph/1.1` on-disk schema.
 *
 * This is vg's own open schema (VG-PACKAGE-AND-SCHEMA.md §4) — informed by good
 * ideas (content-hashed ids, epistemic typing of facts) but standalone and
 * self-contained. Every collection is deterministically serialized
 * (sorted keys, stable element order). These TypeScript shapes are normative.
 *
 * ## Version history
 *
 * - `vg-graph/1.0` — code-only vocabulary.
 * - `vg-graph/1.1` — **additive**: toolchain node kinds (`resource`, `workload`,
 *   `job`, `step`, `image`, `chart`) and toolchain edge kinds (`depends_on`,
 *   `provisions`, `deploys`, `triggers`, `exposes`, `mounts`, `builds_from`),
 *   produced by `engine/toolchain/`. Nothing was removed or renamed, so a 1.0
 *   reader that tolerates unknown kinds reads a 1.1 graph correctly; readers
 *   that hard-match the version string need widening (see
 *   `SUPPORTED_SCHEMA_VERSIONS`).
 */

export const SCHEMA_VERSION = 'vg-graph/1.1' as const;

/**
 * Schema versions a reader should accept. The toolchain vocabulary added in 1.1
 * is purely additive, so a 1.0 artifact still loads — only the newer kinds are
 * absent from it. Readers must prefer this over an equality check on
 * {@link SCHEMA_VERSION}, which rejects perfectly readable older graphs.
 */
export const SUPPORTED_SCHEMA_VERSIONS = ['vg-graph/1.0', 'vg-graph/1.1'] as const;

export type SupportedSchemaVersion = (typeof SUPPORTED_SCHEMA_VERSIONS)[number];

export type ResolverKind = 'scip' | 'stackgraph' | 'tsc' | 'heuristic';

/** Coarse, honest resolution tier for an edge (see engine/epistemic.ts). */
export type EpistemicTier = 'observed' | 'name-matched' | 'declared';

/**
 * The toolchain that produced this graph — the reproducibility fingerprint.
 * Everything here deterministically affects graph *content* (parse trees change
 * between grammar releases; resolvers change which edges resolve), so a CI run
 * and a laptop run that disagree can be caught by comparing `fingerprint`.
 * Deliberately excludes the Node/OS version so the graph stays byte-stable
 * across host runtimes; `fingerprint` pins the parse/resolve toolchain only.
 */
export interface Toolchain {
  schema: string; // SCHEMA_VERSION
  tool: string; // vg calendar version
  grammars: string; // tree-sitter grammar set version string
  resolvers: ResolverKind[]; // resolver kinds available, sorted
  fingerprint: string; // shortId over the fields above — the value `vg attest` signs
}

export interface Provenance {
  tool: 'vg';
  version: string; // calendar version
  grammars: Record<string, string>; // lang → grammar version (determinism input)
  resolver: ResolverKind[];
  deep: boolean; // did the heavier open passes run
  semanticModel?: string; // embedding model id+version if --deep semantic links
  corpusHash: string; // blake3 over the included file set + hashes
  toolchain?: Toolchain; // reproducibility fingerprint (checked by `vg verify`)
}

/** Analysis cost tier — auto-selected by node count (or forced). Reported honestly. */
export type AnalysisTier = 'full' | 'large' | 'xl';

export interface GraphMeta {
  root: string; // relative; portable across machines
  languages: string[];
  counts: {
    nodes: number;
    edges: number;
    areas: number;
    tests: number;
    untested: number;
  };
  cluster: 'leiden' | 'louvain' | 'none';
  /** Auto-selected (or forced) analysis tier for large maps. */
  analysisTier?: AnalysisTier;
  edgeKinds: EdgeKind[];
}

export type NodeKind =
  | 'file'
  | 'module'
  | 'package'
  | 'class'
  | 'interface'
  | 'function'
  | 'method'
  | 'property'
  | 'test'
  | 'route'
  | 'component'
  /** Documentation / config text ingested for semantic ask (markdown, txt, env examples). */
  | 'document'
  | 'external'
  // ── Toolchain kinds (engine/toolchain/) ──────────────────────────────────
  // Structural extraction of the infrastructure/CI corpus. These sit alongside
  // the code kinds above and never replace the `document` node for the same
  // file: the document node stays the semantic-ask surface, these carry the
  // structure. Additive — consumers must tolerate unknown kinds.
  /** A declared infrastructure object: Terraform resource/data, K8s object, Compose service. */
  | 'resource'
  /** A deployable unit that runs containers (Deployment, StatefulSet, DaemonSet, Job, CronJob). */
  | 'workload'
  /** A CI job (GitHub Actions job, GitLab CI job). */
  | 'job'
  /** A single step within a CI job. */
  | 'step'
  /** A container image reference (`ghcr.io/acme/web:1.2.3`) or a Dockerfile build stage. */
  | 'image'
  /** A Helm chart (from `Chart.yaml`). */
  | 'chart';

export interface Span {
  start: number; // 1-based start line
  end: number; // 1-based end line
}

export interface Centrality {
  degree: number;
  pagerank: number;
  betweenness: number;
  eigenvector: number;
}

export type { CallableEffects, Duty };

export interface GraphNode {
  id: string; // blake3(canonical(kind, qualifiedName, file, signature))
  kind: NodeKind;
  name: string; // short name
  qualifiedName: string;
  file: string; // relative path
  span: Span; // line range (excluded from id hash)
  lang: string;
  visibility?: 'public' | 'private' | 'protected' | 'internal';
  signature?: string;
  doc?: string; // short leading doc-comment / docstring summary (deterministic; not a full body)
  /**
   * What the callable's body calls, scanned from its text (never run), as bounded counts (SQL/ORM reads and
   * writes, outbound HTTP, HTTP responses, file I/O, auth, crypto, messaging,
   * cache, logging, rendering, validation, plus fan-out / branch / loop /
   * await / throw / return / state-assignment counts and a few matched API
   * tokens). Additive in vg-graph/1.1; absent for non-callables and empty
   * bodies. Excluded from the id hash. See engine/effects.ts.
   */
  effects?: CallableEffects;
  /**
   * Ordered duties reconstructed from the callable's syntax tree — what each
   * statement would do (`validate SKU`, `persist Product via SaveChangesAsync`,
   * `respond 201`), with a liveness bit (dead after return/throw, in catch,
   * `if (false)`), an optional guard, and `hop` 1–2 for duties inherited from
   * callees along call edges. Additive in vg-graph/1.1; identifiers and short
   * guards only, never source text. Excluded from the id hash. See
   * engine/duties.ts.
   */
  duties?: Duty[];
  importance: number; // 0..1 blended centrality
  centrality: Centrality;
  area: number; // area id (the node's community); -1 = unassigned (cluster "none")
  isHub: boolean; // centrality outlier — surfaced by `vg hubs`
  tested: boolean | null; // null = not analyzable (e.g. external)
  coverage?: number; // 0..1 line coverage if a coverage report was ingested
  changeCoupling?: string[]; // node ids that historically change together
}

export type EdgeKind =
  | 'call'
  | 'import'
  | 'contains'
  | 'extends'
  | 'implements'
  | 'references'
  | 'test'
  | 'coverage'
  // ── Toolchain edge kinds (engine/toolchain/) ─────────────────────────────
  // Every edge below is produced by structural extraction or by the
  // cross-domain linker. Linker-produced edges are always
  // `resolution: 'heuristic'` with a calibrated confidence — an inferred
  // `deploys` is not a declared `import` and must never claim to be.
  /** Declared ordering/reference dependency (Terraform `depends_on` + interpolation, Compose `depends_on`, CI `needs`). */
  | 'depends_on'
  /** An IaC declaration creates infrastructure (Terraform module → resource, chart → workload). */
  | 'provisions'
  /** A CI job or IaC declaration puts a workload/image into an environment. */
  | 'deploys'
  /** An event or upstream job causes a workflow/job to run. */
  | 'triggers'
  /** A workload/service publishes a port or endpoint. */
  | 'exposes'
  /** A workload/service consumes a volume, config map, or secret *by reference*. */
  | 'mounts'
  /** A build stage or workload is derived from a container image. */
  | 'builds_from';

export interface GraphEdge {
  id: string; // blake3(canonical(kind, src, dst))
  kind: EdgeKind;
  src: string; // node id
  dst: string; // node id
  resolution: ResolverKind; // how the edge was resolved
  confidence: number; // 0..1 (1.0 for scip/declared; lower for heuristic/dynamic)
  epistemic?: EpistemicTier; // coarse honesty tier derived from resolution+kind
  surprise?: number; // 0..1 improbability under the area model (`vg oddities`)
  count?: number; // call-site multiplicity
}

export interface Area {
  id: number; // stable across runs (remapped to previous committed map)
  label: string; // most-central member's name (editable via `vg label`)
  size: number;
  members: string[]; // node ids, sorted
  cohesion: number; // 0..1
  externalEdges: number; // cross-area edge count
}

export type FactKind = 'contract' | 'invariant' | 'characterization';
export type DerivedBy = 'declared' | 'static';
export type FactConfidence = 'Observed' | 'Derived';

export interface Fact {
  id: string; // blake3(canonical(kind, subjectIds, predicate))
  kind: FactKind;
  subjectIds: string[]; // node ids this fact constrains
  predicate: unknown; // the constraint
  derivedBy: DerivedBy;
  confidence: FactConfidence;
  evidence: { file: string; span: Span }[];
}

/**
 * A reference the graph could not resolve — surfaced by `vg unknowns`. Reporting
 * what it *cannot* connect (ranked by blast radius) is the honest inverse of a
 * scanner that hides its unknowns. Only unknowns the precise rungs (tsc/scip)
 * did not supersede are recorded, so a compiler-resolved file never shows here.
 */
export interface Unknown {
  from: string; // node id where the unresolved reference occurs
  name: string; // the callee/type name that could not be resolved
  kind: 'call' | 'extends' | 'implements';
  count: number; // occurrences at this site
}

export type GroundingKind = 'should_follow' | 'smells_like' | 'relevant_to';

export interface GroundingEdge {
  src: string; // node id
  packEntryId: string;
  kind: GroundingKind;
  confidence: number; // 0..1
  rationale: 'recommended' | 'conjectured';
  citation: { title: string; url: string };
}

/** Precomputed hub blast-radius counts for fast agent answers (optional). */
export interface HubBlastSummary {
  id: string;
  name: string;
  kind: string;
  file: string;
  importance: number;
  direct: number;
  depth2: number;
  files: number;
  tested: boolean | null;
}

export interface GraphSummaries {
  hubs: HubBlastSummary[];
}

export interface VgGraph {
  /**
   * The schema this artifact was written against. A freshly built graph always
   * carries {@link SCHEMA_VERSION}; a graph *loaded* from disk may carry any
   * member of {@link SUPPORTED_SCHEMA_VERSIONS}, since older artifacts stay
   * readable (the 1.1 additions are additive).
   */
  schemaVersion: SupportedSchemaVersion;
  generatedAt: string; // ISO; the ONLY nondeterministic field (pinned by --generated-at)
  provenance: Provenance;
  meta: GraphMeta;
  nodes: GraphNode[]; // sorted by id
  edges: GraphEdge[]; // sorted by (kind, src, dst)
  areas: Area[]; // sorted by id
  facts?: Fact[]; // open facts (contract/invariant/characterization); sorted by id
  grounding?: GroundingEdge[]; // free-pack grounding (default on; omit with --no-ground)
  unknowns?: Unknown[]; // heuristic references left unresolved; sorted by (from, kind, name)
  /** Build-time hub blast-radius summaries (always on; tiny). */
  summaries?: GraphSummaries;
}
