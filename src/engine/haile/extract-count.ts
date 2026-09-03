/**
 * H3 extract-count helpers. Compare HAILE fixture gold / extract names
 * against callable nodes in a vg-graph/1.x document. A miss is an
 * extract-quality finding — this module never re-parses source.
 */

export const H3_CALLABLE_KINDS = new Set([
  'function',
  'method',
  'route',
  'test',
  'component',
  'job',
]);

export interface GraphNodeLite {
  kind?: string;
  name?: string;
  file?: string;
}

export interface ExtractCountRow {
  vgCallables: number;
  goldTotal: number;
  goldInVg: number;
  goldMissingVg: string[];
}

export function vgCallableNames(nodes: readonly GraphNodeLite[]): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const n of nodes) {
    if (!H3_CALLABLE_KINDS.has(String(n.kind ?? ''))) continue;
    const name = (n.name ?? '').trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  names.sort();
  return names;
}

export function compareExtractCounts(
  nodes: readonly GraphNodeLite[],
  goldNames: readonly string[],
): ExtractCountRow {
  const vg = new Set(vgCallableNames(nodes));
  const gold = [...new Set(goldNames.filter(Boolean))];
  const missing = gold.filter((n) => !vg.has(n)).sort();
  return {
    vgCallables: vg.size,
    goldTotal: gold.length,
    goldInVg: gold.length - missing.length,
    goldMissingVg: missing,
  };
}
