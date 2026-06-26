import { edgeId } from './ids.js';
import type { GraphEdge, GraphNode } from '../schema.js';

/**
 * Test-awareness (VG-ENGINE-TEARDOWN §3.6) — the wedge Graphify has no answer to.
 *
 * Deterministic, two signals:
 *  1. **Static linkage** — calls from a test file into product code become `test`
 *     edges (test file → covered node), so we can answer "which tests exercise
 *     this" from structure alone, no runner needed.
 *  2. **Coverage** (coverage.ts) — runtime-grounded line coverage applied as
 *     `coverage` on nodes (stronger than static linkage when present).
 *
 * A node's `tested` flag is true when it has any incoming test/coverage signal;
 * false for analyzable code with none; null for non-analyzable kinds.
 */

export function isTestFile(rel: string): boolean {
  const lower = rel.toLowerCase();
  const base = rel.split('/').pop() ?? rel; // original case (for CamelCase rules)
  const lbase = base.toLowerCase();
  // Directory-based conventions (case-insensitive).
  if (/(^|\/)(__tests__|__test__)\//.test(lower)) return true;
  if (/(^|\/)(tests?|spec|specs)\//.test(lower)) return true;
  if (/(^|\/)src\/test\//.test(lower)) return true;
  // Filename-based conventions across languages.
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(lbase)) return true; // JS/TS
  if (/^test_.*\.py$/.test(lbase) || /_test\.py$/.test(lbase)) return true; // Python
  if (/_test\.go$/.test(lbase)) return true; // Go
  if (/[A-Za-z0-9](Test|Tests|IT)\.java$/.test(base)) return true; // *Test.java (CamelCase)
  if (/_spec\.rb$/.test(lbase) || /_test\.rb$/.test(lbase)) return true; // Ruby
  if (/[A-Za-z0-9](Test|Tests)\.cs$/.test(base)) return true; // *Test.cs (CamelCase)
  return false;
}

export interface TestAwarenessResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  testFiles: string[]; // rel paths
  testEdgeCount: number;
}

/**
 * Apply static test linkage. Adds `test` edges from each test file node to the
 * product-code nodes its functions call, and sets `tested` on analyzable nodes.
 */
export function applyStaticTestLinkage(nodes: GraphNode[], edges: GraphEdge[]): TestAwarenessResult {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const testFiles = new Set<string>();
  for (const n of nodes) if (n.kind === 'file' && isTestFile(n.file)) testFiles.add(n.file);

  // File node id per rel (to source test edges from the file).
  const fileNodeIdByRel = new Map<string, string>();
  for (const n of nodes) if (n.kind === 'file') fileNodeIdByRel.set(n.file, n.id);

  const covered = new Set<string>(); // node ids with a test signal
  const newEdges = new Map<string, GraphEdge>();

  for (const e of edges) {
    if (e.kind !== 'call') continue;
    const src = byId.get(e.src);
    const dst = byId.get(e.dst);
    if (!src || !dst) continue;
    // A call originating in a test file into non-test product code → test edge.
    if (testFiles.has(src.file) && !testFiles.has(dst.file) && dst.kind !== 'external') {
      const testFileId = fileNodeIdByRel.get(src.file);
      if (!testFileId) continue;
      const id = edgeId('test', testFileId, dst.id);
      if (!newEdges.has(id)) {
        newEdges.set(id, {
          id,
          kind: 'test',
          src: testFileId,
          dst: dst.id,
          resolution: e.resolution,
          confidence: e.confidence,
        });
      }
      covered.add(dst.id);
    }
  }

  const outNodes = nodes.map((n) => ({ ...n, tested: testedFlag(n, covered.has(n.id), testFiles) }));
  const outEdges = [...edges, ...newEdges.values()].sort(
    (a, b) => a.kind.localeCompare(b.kind) || a.src.localeCompare(b.src) || a.dst.localeCompare(b.dst),
  );

  return {
    nodes: outNodes,
    edges: outEdges,
    testFiles: [...testFiles].sort(),
    testEdgeCount: newEdges.size,
  };
}

/** Analyzable code units get true/false; everything else stays null. */
function testedFlag(node: GraphNode, covered: boolean, testFiles: Set<string>): boolean | null {
  if (node.kind === 'external' || node.kind === 'file' || node.kind === 'package' || node.kind === 'module') {
    return null;
  }
  if (testFiles.has(node.file)) return null; // the test code itself isn't "tested"
  if (node.kind === 'function' || node.kind === 'method') return covered;
  // Classes/interfaces/etc.: covered if any signal, else leave null (not a unit).
  return covered ? true : node.tested ?? null;
}
