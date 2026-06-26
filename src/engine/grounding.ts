import { FREE_PACK, type KnowledgePack, type PackEntry } from '../grounding/pack.js';
import type { GraphEdge, GraphNode, GroundingEdge } from '../schema.js';
import type { FileParse } from './types.js';

/**
 * Grounding (VG-PACKAGE-AND-SCHEMA §6) — match nodes to knowledge-pack entries by
 * deterministic signals (file imports, called APIs, identifier keywords) and
 * attach cited framing edges. Closed-world tools can't follow without building a
 * corpus. Deterministic-first; the free pack ships in the open CLI.
 */
export function groundGraph(
  nodes: GraphNode[],
  edges: GraphEdge[],
  parses: FileParse[],
  packs: KnowledgePack[] = [FREE_PACK],
): GroundingEdge[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const importsByFile = new Map<string, string[]>();
  for (const p of parses) importsByFile.set(p.rel, p.imports.map((i) => i.source.toLowerCase()));

  // callee names per node (from call edges).
  const calleesByNode = new Map<string, string[]>();
  for (const e of edges) {
    if (e.kind !== 'call') continue;
    const callee = byId.get(e.dst)?.name;
    if (!callee) continue;
    const list = calleesByNode.get(e.src);
    if (list) list.push(callee.toLowerCase());
    else calleesByNode.set(e.src, [callee.toLowerCase()]);
  }

  const out: GroundingEdge[] = [];
  for (const n of nodes) {
    if (n.kind === 'file' || n.kind === 'external') continue;
    const nameParts = new Set(
      n.name
        .split(/[^a-zA-Z0-9]+|(?<=[a-z])(?=[A-Z])/)
        .filter(Boolean)
        .map((s) => s.toLowerCase()),
    );
    const imports = importsByFile.get(n.file) ?? [];
    const callees = calleesByNode.get(n.id) ?? [];

    for (const pack of packs) {
      for (const entry of pack.entries) {
        const conf = matchConfidence(entry, nameParts, imports, callees);
        if (conf > 0) {
          out.push({
            src: n.id,
            packEntryId: entry.id,
            kind: entry.kind,
            confidence: conf,
            rationale: entry.rationale,
            citation: entry.citation,
          });
        }
      }
    }
  }

  return out.sort(
    (a, b) =>
      a.src.localeCompare(b.src) || a.packEntryId.localeCompare(b.packEntryId),
  );
}

function matchConfidence(
  entry: PackEntry,
  nameParts: Set<string>,
  imports: string[],
  callees: string[],
): number {
  let conf = 0;
  if (entry.match.imports) {
    for (const sig of entry.match.imports) {
      if (imports.some((imp) => imp.includes(sig.toLowerCase()))) {
        conf = Math.max(conf, 0.8);
        break;
      }
    }
  }
  if (entry.match.calls) {
    const want = new Set(entry.match.calls.map((s) => s.toLowerCase()));
    if (callees.some((c) => want.has(c))) conf = Math.max(conf, 0.7);
  }
  if (entry.match.keywords) {
    if (entry.match.keywords.some((k) => nameParts.has(k.toLowerCase()))) {
      conf = Math.max(conf, 0.5);
    }
  }
  return conf;
}
