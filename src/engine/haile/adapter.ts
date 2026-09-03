/** H0: map vg-graph/1.x callable nodes onto HAILE callables. Does not re-parse. */

import type { GraphEdge, GraphNode, VgGraph } from '../../schema.js';
import type { HaileCallable, HaileSymbolKind } from './types.js';

const CALLABLE_KINDS = new Set(['function', 'method', 'route', 'test', 'component', 'job']);

export function isCallableKind(kind: string): boolean {
  return CALLABLE_KINDS.has(kind);
}

export function symbolKindOf(kind: string): HaileSymbolKind {
  switch (kind) {
    case 'method':
      return 'method';
    case 'route':
      return 'route';
    case 'test':
      return 'test';
    case 'job':
      return 'job';
    case 'component':
      return 'handler';
    default:
      return 'function';
  }
}

export interface AdaptOptions {
  fileLayerByPath?: Map<string, string>;
  astRoleByPath?: Map<string, string>;
}

function parseParams(signature: string): Array<{ name: string; type_name?: string }> {
  const open = signature.indexOf('(');
  const close = signature.lastIndexOf(')');
  if (open < 0 || close <= open) return [];
  const inner = signature.slice(open + 1, close).trim();
  if (!inner || inner === 'void') return [];
  return inner
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, 16)
    .map((part) => {
      const cleaned = part.replace(/\b(const|mut|ref|public|private|protected|readonly|final)\b/g, '').trim();
      if (cleaned.includes(':')) {
        const [name, typeName] = cleaned.split(':').map((s) => s.trim());
        return { name: name || 'arg', type_name: typeName || undefined };
      }
      const bits = cleaned.split(/\s+/);
      if (bits.length >= 2) return { name: bits[bits.length - 1]!, type_name: bits[0] };
      return { name: cleaned };
    });
}

function parseReturnType(signature: string): string | undefined {
  const arrow = signature.lastIndexOf('->');
  if (arrow >= 0) return signature.slice(arrow + 2).replace(/[{;].*$/, '').trim() || undefined;
  const colon = signature.lastIndexOf(':');
  const paren = signature.lastIndexOf(')');
  if (colon > paren && paren >= 0) {
    return signature.slice(colon + 1).replace(/[{;=>].*$/, '').trim() || undefined;
  }
  return undefined;
}

function callsFor(nodeId: string, edges: GraphEdge[], idToName: Map<string, string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const e of edges) {
    if (e.src !== nodeId) continue;
    if (e.kind !== 'call' && e.kind !== 'references') continue;
    const name = idToName.get(e.dst);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
    if (out.length >= 24) break;
  }
  return out;
}

export function adaptGraph(graph: Pick<VgGraph, 'nodes' | 'edges'>, options: AdaptOptions = {}): HaileCallable[] {
  const idToName = new Map<string, string>();
  for (const n of graph.nodes) idToName.set(n.id, n.name);
  const out: HaileCallable[] = [];
  for (const node of graph.nodes) {
    if (!isCallableKind(node.kind)) continue;
    const signature = `${node.decorators ? `${node.decorators} ` : ''}${node.signature ?? ''}`;
    const callable: HaileCallable = {
      node_id: node.id,
      file_path: node.file,
      name: node.name,
      qualified_name: node.qualifiedName || node.name,
      symbol_kind: symbolKindOf(node.kind),
      language: node.lang ?? '',
      signature,
      calls: callsFor(node.id, graph.edges, idToName),
      parameters: parseParams(signature),
      return_type: parseReturnType(signature),
    };
    const layer = options.fileLayerByPath?.get(node.file);
    if (layer) callable.file_layer = layer;
    const astRole = options.astRoleByPath?.get(node.file);
    if (astRole) callable.ast_role = astRole;
    out.push(callable);
  }
  out.sort((a, b) => (a.node_id < b.node_id ? -1 : a.node_id > b.node_id ? 1 : 0));
  return out;
}
