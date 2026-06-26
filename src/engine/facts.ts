import { canonicalize, shortId } from './hash.js';
import type { Fact, GraphEdge, GraphNode } from '../schema.js';
import type { FileParse } from './types.js';

/**
 * The open facts subset (VG-PACKAGE-AND-SCHEMA §5) — reimplemented fresh in the
 * open engine: deterministic, no runtime, no corpus, no LLM, no hidden pipeline.
 * Three commodity fact kinds, each epistemic-typed so it never claims more than
 * the open layer can prove:
 *
 *  - **contract** — from a public signature/type        (declared → Observed)
 *  - **invariant** — from a static assert/guard          (static → Derived)
 *  - **characterization** — from existing test linkage   (static → Observed)
 *
 * Emitted with `--deep`.
 */
export function buildFacts(parses: FileParse[], nodes: GraphNode[], edges: GraphEdge[]): Fact[] {
  const facts: Fact[] = [];
  const byId = new Map(nodes.map((n) => [n.id, n]));

  // Index code defs per file for line→enclosing-def lookup (invariants).
  const defsByFile = new Map<string, GraphNode[]>();
  for (const n of nodes) {
    if (n.kind === 'file' || n.kind === 'external') continue;
    const list = defsByFile.get(n.file);
    if (list) list.push(n);
    else defsByFile.set(n.file, [n]);
  }

  // --- contracts (from signatures) ---
  for (const n of nodes) {
    if ((n.kind === 'function' || n.kind === 'method') && n.signature) {
      facts.push(makeFact('contract', [n.id], { signature: n.signature }, 'declared', 'Observed', [
        { file: n.file, span: n.span },
      ]));
    }
  }

  // --- invariants (from static guards) ---
  for (const p of parses) {
    const defs = defsByFile.get(p.rel);
    if (!defs) continue;
    for (const g of p.guards) {
      const owner = enclosing(defs, g.line);
      if (!owner) continue;
      facts.push(
        makeFact('invariant', [owner.id], { guard: g.expr }, 'static', 'Derived', [
          { file: p.rel, span: { start: g.line, end: g.line } },
        ]),
      );
    }
  }

  // --- characterization (from test linkage) ---
  const testsByNode = new Map<string, string[]>();
  for (const e of edges) {
    if (e.kind !== 'test') continue;
    const testFile = byId.get(e.src)?.file;
    if (!testFile) continue;
    const list = testsByNode.get(e.dst);
    if (list) list.push(testFile);
    else testsByNode.set(e.dst, [testFile]);
  }
  for (const [nodeId, testFiles] of testsByNode) {
    const n = byId.get(nodeId);
    if (!n) continue;
    facts.push(
      makeFact(
        'characterization',
        [nodeId],
        { pinnedBy: [...new Set(testFiles)].sort() },
        'static',
        'Observed',
        [{ file: n.file, span: n.span }],
      ),
    );
  }

  return facts.sort((a, b) => a.id.localeCompare(b.id));
}

function makeFact(
  kind: Fact['kind'],
  subjectIds: string[],
  predicate: unknown,
  derivedBy: Fact['derivedBy'],
  confidence: Fact['confidence'],
  evidence: Fact['evidence'],
): Fact {
  const id = shortId(canonicalize({ t: 'fact', kind, subjectIds, predicate }));
  return { id, kind, subjectIds, predicate, derivedBy, confidence, evidence };
}

/** Smallest def whose line span contains `line`. */
function enclosing(defs: GraphNode[], line: number): GraphNode | undefined {
  let best: GraphNode | undefined;
  for (const d of defs) {
    if (d.span.start <= line && d.span.end >= line) {
      if (!best || d.span.end - d.span.start < best.span.end - best.span.start) best = d;
    }
  }
  return best;
}
