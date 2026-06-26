/**
 * The `vg-graph/1.0` on-disk schema.
 *
 * This is vg's own open schema (VG-PACKAGE-AND-SCHEMA.md §4) — informed by good
 * ideas (content-hashed ids, epistemic typing of facts) but standalone and
 * self-contained. Every collection is deterministically serialized
 * (sorted keys, stable element order). These TypeScript shapes are normative.
 */

export const SCHEMA_VERSION = 'vg-graph/1.0' as const;

export type ResolverKind = 'scip' | 'stackgraph' | 'tsc' | 'heuristic';

export interface Provenance {
  tool: 'vg';
  version: string; // calendar version
  grammars: Record<string, string>; // lang → grammar version (determinism input)
  resolver: ResolverKind[];
  deep: boolean; // did the heavier open passes run
  semanticModel?: string; // embedding model id+version if --deep semantic links
  corpusHash: string; // blake3 over the included file set + hashes
}

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
  | 'external';

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
  | 'coverage';

export interface GraphEdge {
  id: string; // blake3(canonical(kind, src, dst))
  kind: EdgeKind;
  src: string; // node id
  dst: string; // node id
  resolution: ResolverKind; // how the edge was resolved
  confidence: number; // 0..1 (1.0 for scip/declared; lower for heuristic/dynamic)
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

export type GroundingKind = 'should_follow' | 'smells_like' | 'relevant_to';

export interface GroundingEdge {
  src: string; // node id
  packEntryId: string;
  kind: GroundingKind;
  confidence: number; // 0..1
  rationale: 'recommended' | 'conjectured';
  citation: { title: string; url: string };
}

export interface VgGraph {
  schemaVersion: typeof SCHEMA_VERSION;
  generatedAt: string; // ISO; the ONLY nondeterministic field (pinned by --generated-at)
  provenance: Provenance;
  meta: GraphMeta;
  nodes: GraphNode[]; // sorted by id
  edges: GraphEdge[]; // sorted by (kind, src, dst)
  areas: Area[]; // sorted by id
  facts?: Fact[]; // present with --deep; sorted by id
  grounding?: GroundingEdge[]; // free-pack grounding (default on; omit with --no-ground)
}
