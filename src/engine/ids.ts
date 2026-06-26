import { canonicalize, shortId } from './hash.js';
import type { EdgeKind, NodeKind } from '../schema.js';

/**
 * Content-addressed ids. The id of a node is a function only of its *identity*
 * (kind, qualified name, file, signature) — never its line span, which can move
 * without changing the node. So adding a blank line above a function leaves its
 * id (and every edge touching it) byte-identical.
 */

export interface NodeIdParts {
  kind: NodeKind;
  qualifiedName: string;
  file: string;
  signature?: string;
}

export function nodeId(parts: NodeIdParts): string {
  return shortId(
    canonicalize({
      t: 'node',
      kind: parts.kind,
      qn: parts.qualifiedName,
      file: parts.file,
      sig: parts.signature ?? '',
    }),
  );
}

export function edgeId(kind: EdgeKind, src: string, dst: string): string {
  return shortId(canonicalize({ t: 'edge', kind, src, dst }));
}
