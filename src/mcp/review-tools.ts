/**
 * `review_doc` — an agent writes the review document for a change, over MCP.
 *
 * One tool with an `op` argument, listed only under `vg serve --review`
 * (`VG_REVIEW=1`): a default `vg serve` lists exactly the tools it did before,
 * because every listed schema is billed on every agent step
 * (IDE-INTEGRATION-PLAN §2, FEATURE-DESIGN-PRINCIPLES P2).
 *
 * A thin adapter: every rule (one document per scope, atomic patches, version
 * checks, provenance that cannot be forged, pins checked against the change,
 * retention) lives in `review/doc-store.ts`, shared with `vg review doc`, so
 * the CLI and the tool cannot disagree.
 *
 * Annotations: it writes only Vibgrate's own state (`.vibgrate/review-docs/`),
 * never the repository, and every write adds a version rather than replacing
 * one, so nothing an agent does here can lose work: `readOnlyHint: false`,
 * `destructiveHint: false`, as for `compress_content` and `memory_save`.
 * `openWorldHint: true` because ops `comments` and `reply` read and answer
 * the comments people left on the pushed document in Vibgrate Cloud.
 *
 * Op "explain" with `keep` and doc_id "scratchpad" reach the explain
 * scratchpad (`review/scratchpad.ts`), stored beside the review documents.
 */

import type { DocScope } from '../review/doc-build.js';
import type { ReviewDoc } from '../review/doc.js';
import {
  checkDocument,
  documentHistory,
  getDocument,
  MAX_OPS,
  openDocument,
  outline,
  patchDocument,
  restoreVersion,
} from '../review/doc-store.js';
import type { VgTool } from './tools.js';
import type { GraphNode, VgGraph } from '../schema.js';
import { resolveOne } from '../engine/lookup.js';
import { callPath, shortestPath } from '../engine/paths.js';
import { loadHaileProvider } from '../engine/haile/haile-provider.js';
import { buildExplainDoc, buildPathDoc, ExplainEmpty } from '../review/explain-doc.js';
import { clearScratchpad, getScratchpad, keepInScratchpad, patchScratchpad, SCRATCHPAD_ID, type Scratchpad } from '../review/scratchpad.js';
import { cloudDsn, fetchComments, replyToComment, targetOf } from '../review/doc-comments.js';

/** Inline the whole document only below this size; above it the outline plus `get` by block keeps every result inside the token budget. */
const INLINE_DOC_CHARS = 60_000;

const DESCRIPTION = [
  'Write the review document for a change: what and why, requirements, one primary design diagram, implementation — every claim about code pinned to lines.',
  'Order: (1) op "open" (the change, or `session` for a VG Code chat) and read the outline; (2) write what and why first (set_text on its first block);',
  '(3) add requirements from the task; (4) add or correct diagrams — pin every node to code as {side:"head"|"base", path, start, end}, or link text as [label](head:path#L10-L24);',
  '(5) op "check" and re-read before you finish.',
  'Patches are all or nothing and name the version they were written against; a pin that does not land, or a stale version, saves nothing and says why.',
  'Whatever you write is recorded as origin "agent"; only unchanged graph-derived elements stay "graph".',
  'After the document is pushed (`vg review doc --push`), op "comments" lists what people asked on its blocks in Vibgrate Cloud, and op "reply" answers a thread (comment_id, text); replies are shown as written by an agent.',
  'To explain code as it is rather than a change, op "explain" with `symbol` returns the same kind of document (kind "explain": what it is, how it is reached, its flow, the data it reads and writes, where it sits); add `to` for the call path from symbol to `to`. It is not saved unless you pass `keep: true`, which puts it on top of the scratchpad (doc_id "scratchpad"): the always-present explain canvas the person sees in VS Code, newest on top. Patch the scratchpad by block id like a review document (ops get, patch, check, clear); start your own entry with a markdown block whose text begins "#### ". Reply to the person in one line and let the scratchpad carry the explanation.',
].join(' ');

const PIN = {
  type: 'object',
  properties: {
    side: { type: 'string', enum: ['base', 'head'] },
    path: { type: 'string' },
    start: { type: 'integer', minimum: 1 },
    end: { type: 'integer', minimum: 1 },
  },
  required: ['side', 'path', 'start', 'end'],
};

const SCHEMA = {
  type: 'object',
  properties: {
    op: { type: 'string', enum: ['open', 'get', 'patch', 'check', 'history', 'restore', 'comments', 'reply', 'explain', 'clear'] },
    doc_id: { type: 'string', description: 'from open (rd_…), or "scratchpad"; required for every op but open and explain' },
    base: { type: 'string', description: 'open: review HEAD against the merge-base with this ref (default: working tree vs HEAD)' },
    in_place: { type: 'boolean', description: 'open: with base, include the working tree' },
    session: { type: 'string', description: 'open: a VG Code chat id, or "latest" — only the files it touched, its requests as requirements' },
    fresh: { type: 'boolean', description: 'open: rebuild from the change as a new version instead of reusing the saved one' },
    base_graph: { type: 'boolean', description: 'open: also map the base commit for before/after call paths (slower)' },
    block: { type: 'string', description: 'get: return one block by id' },
    symbol: { type: 'string', description: 'explain: the code to explain — qualified name, short name, file:line or id' },
    to: { type: 'string', description: 'explain: draw the path from symbol to this one instead' },
    calls_only: { type: 'boolean', description: 'explain with to: follow call edges only (default true)' },
    keep: { type: 'boolean', description: 'explain: also put it on top of the scratchpad (doc_id "scratchpad")' },
    comment_id: { type: 'string', description: 'reply: the comment (rdc_…) to answer, from op "comments"' },
    text: { type: 'string', description: 'reply: your answer, plain text, at most 4000 characters' },
    version: { type: 'integer', minimum: 1, description: 'patch: the version you read (required); get/restore: which version' },
    ops: {
      type: 'array',
      maxItems: MAX_OPS,
      description:
        'patch: [{op:"set_text",block,text} | {op:"insert",section,block,after?|at?:"start"} | {op:"replace",block,with} | {op:"remove",block} | {op:"move",block,section,after?} | {op:"set_primary",block} | {op:"set_title",title}]. section: what_why | requirements | design | implementation. Block types: markdown, callout{tone,text,pins?}, code_peek{pin,caption?}, flow{title,nodes[{key,label,kind?,pins}],edges[{from,to,label?,kind?}]}, sequence{title,actors,steps[{from,to,label,pins|note}]}, call_stack_diff, data_store, system_map, divider.',
      items: { type: 'object' },
    },
  },
  required: ['op'],
  additionalProperties: false,
  $defs: { pin: PIN },
};

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/** The document, or only its outline when inlining it would crowd the agent's context. */
function view(doc_id: string | null, version: number | null, doc: ReviewDoc): Record<string, unknown> {
  const json = JSON.stringify(doc);
  return {
    doc_id,
    version,
    outline: outline(doc),
    ...(json.length <= INLINE_DOC_CHARS ? { doc } : { doc: null, hint: `the document is ${json.length} characters; read blocks with op "get" and block <id>` }),
  };
}

function scopeFrom(args: Record<string, unknown>): DocScope {
  const session = str(args.session);
  const base = str(args.base) ?? null;
  return session ? { kind: 'session', session, base } : { kind: 'change', base, in_place: args.in_place === true };
}

/**
 * op "explain": the explain document for a symbol, or for the path between
 * two. Read-only, not saved: it describes code as it is, so there is nothing
 * to version against.
 */
async function explain(root: string, graph: VgGraph, args: Record<string, unknown>): Promise<unknown> {
  if (graph.nodes.length === 0) return { error: 'no_code_map', message: 'explain needs a code map — run `vg` in the repository first' };
  const symbol = str(args.symbol);
  if (!symbol) return { error: 'bad_request', message: 'explain needs symbol' };
  const pick = (name: string): { node: GraphNode } | { error: string; message: string; candidates: string[] } => {
    const r = resolveOne(graph, name);
    return r.node ? { node: r.node } : { error: r.candidates.length ? 'ambiguous' : 'not_found', message: `"${name}" ${r.candidates.length ? 'is ambiguous' : 'matches no node'}`, candidates: r.candidates.slice(0, 10).map((n) => n.qualifiedName) };
  };
  const from = pick(symbol);
  if (!('node' in from)) return from;
  const toName = str(args.to);
  try {
    const answer = (doc: ReviewDoc) => {
      if (args.keep !== true) return { ...view(null, null, doc), saved: false };
      const pad = keepInScratchpad(root, doc);
      return { ...view(pad.doc_id, pad.version, pad.doc ?? doc), saved: true, kept: doc.title };
    };
    if (!toName) {
      const { doc } = buildExplainDoc({ root, graph, node: from.node, provider: await loadHaileProvider() });
      return answer(doc);
    }
    const to = pick(toName);
    if (!('node' in to)) return to;
    const callsOnly = args.calls_only !== false;
    const found = callsOnly ? callPath(graph, from.node.id, to.node.id) : shortestPath(graph, from.node.id, to.node.id);
    if (!found) return { error: 'not_found', message: `no ${callsOnly ? 'call ' : ''}path between ${from.node.qualifiedName} and ${to.node.qualifiedName}` };
    const { doc } = buildPathDoc({ root, graph, path: found, callsOnly });
    return answer(doc);
  } catch (err) {
    if (err instanceof ExplainEmpty) return { error: 'not_found', message: err.message };
    throw err;
  }
}

/** Ops on the explain scratchpad (review/scratchpad.ts): one document per repository, no history. */
function scratchpadOp(root: string, op: string | undefined, args: Record<string, unknown>): unknown {
  const shown = (pad: Scratchpad) => ({ ...(pad.doc ? view(pad.doc_id, pad.version, pad.doc) : { doc_id: pad.doc_id, version: pad.version, doc: null }), stale: pad.stale });
  switch (op) {
    case 'get': {
      const pad = getScratchpad(root);
      const block = str(args.block);
      if (!block || !pad.doc) return shown(pad);
      const b = pad.doc.sections.flatMap((s) => s.blocks).find((x) => x.id === block);
      return b ? { doc_id: pad.doc_id, version: pad.version, block: b } : { error: 'not_found', message: `no block ${block} in version ${pad.version}`, outline: outline(pad.doc) };
    }
    case 'check': {
      const pad = getScratchpad(root);
      return { doc_id: pad.doc_id, version: pad.version, valid: pad.stale.length === 0, stale: pad.stale };
    }
    case 'patch': {
      const version = typeof args.version === 'number' ? args.version : undefined;
      if (version === undefined) return { error: 'bad_request', message: 'patch needs version: the version you read' };
      const res = patchScratchpad(root, version, args.ops);
      if (!res.ok) return { saved: false, doc_id: SCRATCHPAD_ID, ...res };
      return { saved: true, notes: res.notes, ...shown(res.scratchpad) };
    }
    case 'clear':
      return { cleared: true, was_version: clearScratchpad(root) };
    default:
      return { error: 'bad_request', message: 'the scratchpad takes ops get, patch, check and clear; explain with keep: true adds to it' };
  }
}

async function run(root: string, graph: VgGraph, args: Record<string, unknown>): Promise<unknown> {
  const op = str(args.op);
  if (op === 'explain') return explain(root, graph, args);
  if (op === 'open') {
    const opened = await openDocument(root, scopeFrom(args), { fresh: args.fresh === true, baseGraph: args.base_graph === true });
    return { ...view(opened.doc_id, opened.version, opened.doc), built: opened.built, ...(opened.reason ? { rebuilt_because: opened.reason } : {}) };
  }
  const id = str(args.doc_id);
  if (!id) return { error: 'bad_request', message: `op "${op ?? ''}" needs doc_id — call op "open" first` };
  if (id === SCRATCHPAD_ID) return scratchpadOp(root, op, args);
  const version = typeof args.version === 'number' ? args.version : undefined;
  switch (op) {
    case 'get': {
      const got = getDocument(root, id, version);
      const block = str(args.block);
      if (!block) return view(got.doc_id, got.version, got.doc);
      for (const s of got.doc.sections) {
        const b = s.blocks.find((x) => x.id === block);
        if (b) return { doc_id: id, version: got.version, section: s.kind, block: b };
      }
      return { error: 'not_found', message: `no block ${block} in version ${got.version}`, outline: outline(got.doc) };
    }
    case 'patch': {
      if (version === undefined) return { error: 'bad_request', message: 'patch needs version: the version you read' };
      const res = patchDocument(root, id, version, args.ops);
      if (!res.ok) return { saved: false, ...res };
      return { saved: true, notes: res.notes, ...view(res.doc_id, res.version, res.doc) };
    }
    case 'check':
      return checkDocument(root, id);
    case 'history':
      return documentHistory(root, id);
    case 'restore': {
      if (version === undefined) return { error: 'bad_request', message: 'restore needs version' };
      const res = restoreVersion(root, id, version);
      if (!res.ok) return { saved: false, ...res };
      return { saved: true, ...view(res.doc_id, res.version, res.doc) };
    }
    case 'comments': {
      // The pushed copy of this document: same repository, head and base.
      const { doc } = getDocument(root, id);
      const { title, threads } = await fetchComments(cloudDsn(), targetOf(doc));
      return { doc_id: id, title, open: threads.filter((t) => !t.resolved), resolved: threads.filter((t) => t.resolved).length };
    }
    case 'reply': {
      const commentId = str(args.comment_id);
      const text = str(args.text);
      if (!commentId || !text) return { error: 'bad_request', message: 'reply needs comment_id and text' };
      const { doc } = getDocument(root, id);
      return { replied: true, comment: await replyToComment(cloudDsn(), targetOf(doc), commentId, text, 'review_doc') };
    }
    default:
      return { error: 'bad_request', message: 'op must be one of open, get, patch, check, history, restore, comments, reply, explain, clear (clear takes doc_id "scratchpad")' };
  }
}

export const REVIEW_TOOLS: VgTool[] = [
  {
    name: 'review_doc',
    description: DESCRIPTION,
    inputSchema: SCHEMA,
    // It reads the code map itself when one exists, and works without one
    // (op "explain" alone needs it, and says so when it is missing).
    graphless: true,
    // comments and reply reach Vibgrate Cloud with the workspace DSN.
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    handler: async (graph, args, ctx) => {
      try {
        return await run(ctx.root, graph, args);
      } catch (err) {
        return { error: 'review_doc_failed', message: (err as Error).message };
      }
    },
  },
];
