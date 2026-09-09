/**
 * In-memory fixtures shared by the review test suites.
 *
 * Everything here is built by hand — no git is spawned and no map is built —
 * so a test can state the exact graph, change set and capsule it reasons
 * about. Not shipped: nothing under `src/` imports this except `*.test.ts`.
 */

import { DEFAULT_REVIEW_CONFIG, type ReviewConfig } from './config.js';
import type { ChangeSet, ChangedFile } from './git.js';
import type { Area, GraphEdge, GraphNode, NodeKind, VgGraph } from '../schema.js';
import {
  CAPSULE_SCHEMA,
  FINDINGS_SCHEMA,
  type AnalysisCapsule,
  type ReviewFinding,
  type ReviewFindings,
} from './schemas.js';

// ── graph ───────────────────────────────────────────────────────────────────

export function node(
  id: string,
  file: string,
  overrides: Partial<GraphNode> & { kind?: NodeKind } = {},
): GraphNode {
  return {
    id,
    kind: 'function',
    name: id,
    qualifiedName: `${file}:${id}`,
    file,
    span: { start: 1, end: 10 },
    lang: 'typescript',
    importance: 0,
    centrality: { degree: 0, pagerank: 0, betweenness: 0, eigenvector: 0 },
    area: -1,
    isHub: false,
    tested: null,
    ...overrides,
  };
}

export function edge(kind: GraphEdge['kind'], src: string, dst: string, overrides: Partial<GraphEdge> = {}): GraphEdge {
  // Short ids, distinct within their first 12 characters — the capsule cites an
  // edge by that prefix, so two fixture edges must never share it.
  return { id: `${src}>${dst}:${kind}`, kind, src, dst, resolution: 'heuristic', confidence: 1, ...overrides };
}

export function graph(
  nodes: GraphNode[],
  edges: GraphEdge[] = [],
  overrides: { areas?: Area[]; corpusHash?: string; languages?: string[] } = {},
): VgGraph {
  return {
    schemaVersion: 'vg-graph/1.1',
    generatedAt: '2026-01-01T00:00:00Z',
    provenance: {
      tool: 'vg',
      version: 'test',
      grammars: {},
      resolver: ['heuristic'],
      deep: false,
      corpusHash: overrides.corpusHash ?? 'corpus-1',
    },
    meta: {
      root: '.',
      languages: overrides.languages ?? ['typescript'],
      counts: { nodes: nodes.length, edges: edges.length, areas: overrides.areas?.length ?? 0, tests: 0, untested: 0 },
      cluster: 'none',
      edgeKinds: [...new Set(edges.map((e) => e.kind))],
    },
    nodes,
    edges,
    areas: overrides.areas ?? [],
  };
}

// ── change set ──────────────────────────────────────────────────────────────

export function changed(path: string, overrides: Partial<ChangedFile> = {}): ChangedFile {
  return { path, op: 'modified', addedLines: 1, removedLines: 0, hunks: [], ...overrides };
}

export function changeSet(files: ChangedFile[], overrides: Partial<ChangeSet> = {}): ChangeSet {
  return {
    topLevel: '/repo',
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    mergeBase: null,
    ref: 'refs/heads/feat/x',
    dirty: false,
    dirtyTreeHash: null,
    files,
    remote: 'github.com/acme/ledger',
    ...overrides,
  };
}

// ── capsule + findings ──────────────────────────────────────────────────────

export function capsule(overrides: Partial<AnalysisCapsule> = {}): AnalysisCapsule {
  return {
    schema_version: CAPSULE_SCHEMA,
    identity: {
      repo_pseudonym: 'sha256:abc',
      language: 'typescript',
      graph_schema: 'vg-graph/1.1',
      analyzer_versions: { graph: '1', scanners: '1' },
      profile: 'interactive-narrow',
    },
    change: {
      base_sha: 'a'.repeat(40),
      head_sha: 'b'.repeat(40),
      dirty: false,
      dirty_tree_hash: null,
      symbols: [],
      ops: [],
      added_edges: [],
      removed_edges: [],
      contract_changes: [],
    },
    roles: [],
    areas: [],
    patterns: {
      observed_dominant_pattern: 'layered',
      declared_target_pattern: 'layered',
      approved_exceptions: [],
      legacy_pattern: null,
      unknown: false,
    },
    paths: [],
    security: [],
    policies: [],
    verification: [],
    evidence: [],
    ...overrides,
  };
}

export function finding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    id: 'arch-01',
    kind: 'boundary_bypass',
    severity: 'high',
    confidence: 0.95,
    claim: 'The new handler calls persistence directly.',
    evidence_ids: ['edge:1'],
    target_alignment: 'regression',
    remediation: 'Route through the application service.',
    paths: ['src/a.ts'],
    source: 'scanner',
    ...overrides,
  };
}

export function findings(overrides: Partial<ReviewFindings> = {}): ReviewFindings {
  return {
    schema_version: FINDINGS_SCHEMA,
    change_class: ['architecture'],
    architecture_findings: [],
    security_findings: [],
    unknowns: [],
    required_checks: [],
    ...overrides,
  };
}

export const config = (o: Partial<ReviewConfig> = {}): ReviewConfig => ({ ...DEFAULT_REVIEW_CONFIG, ...o });
