/**
 * The explain view: a review document for code as it is, not for a change.
 * `vg show <name> --diagram` and the VS Code "Show diagrams" command both
 * build it here.
 *
 * The symbol's own span stands in for a change, so the Architecture module
 * derives the same diagrams it derives for a review (how the code is reached,
 * its flow, the data it reads and writes, where it sits). The module gets
 * `mode: "explain"`, so nothing is marked new or edited and the call path has
 * no before side. The text around the diagrams is graph facts only: what the
 * symbol is, where it lives, and its pinned callers and callees.
 */

import * as path from 'node:path';
import { resolveGraphPath } from '../engine/artifacts.js';
import { overviewOf } from '../engine/chart/server.js';
import { readHaileSidecar } from '../engine/haile/sidecar.js';
import type { HaileProvider } from '../engine/haile/haile-provider.js';
import { indexFor } from '../engine/relations.js';
import { describeHops, type PathResult } from '../engine/paths.js';
import type { GraphNode, VgGraph } from '../schema.js';
import { readDataModels } from './data-models.js';
import { deriveDiagrams, mapPrefix, rolesOf } from './derive.js';
import {
  DOC_SCHEMA,
  makePinResolver,
  mdEscape,
  pinLink,
  plural,
  sealReviewDoc,
  validateReviewDoc,
  withIds,
  type DocBlock,
  type DocSection,
  type Pin,
  type PinResolver,
  type ReviewDoc,
  type StackFrame,
} from './doc.js';
import { defaultRun, gitTopLevel, isGitRepo, normalizeRemote, repoKey, type ChangeSet, type GitRunner } from './git.js';

/** Thrown when a narrowed explain view has nothing to show; the message says why. */
export class ExplainEmpty extends Error {}

/** Callers and callees listed under implementation, each. */
export const MAX_LISTED = 12;

export interface ExplainOptions {
  /** Directory the code map was built from. */
  root: string;
  graph: VgGraph;
  node: GraphNode;
  graphPath?: string;
  provider: HaileProvider | null;
  run?: GitRunner;
  /** Keep only these diagram types in "How it works" (`vg show flow` keeps flows). */
  only?: DocBlock['type'][];
}

export interface BuiltExplainDoc {
  doc: ReviewDoc;
  resolve: PinResolver;
}

/** A change whose one "edit" is the symbol's span, read from the working tree. */
export function explainChange(root: string, node: GraphNode, run: GitRunner = defaultRun): ChangeSet {
  const git = isGitRepo(root, run);
  const topLevel = git ? gitTopLevel(root, run) : root;
  const prefix = path.relative(topLevel, root).split(path.sep).join('/');
  const rel = node.file.replace(/\\/g, '/');
  const head = git ? run(['rev-parse', 'HEAD'], root).stdout.trim() : '';
  const remoteRaw = git ? run(['config', '--get', 'remote.origin.url'], root) : null;
  const sha = head || 'working-tree';
  return {
    topLevel,
    baseSha: sha,
    headSha: sha,
    mergeBase: null,
    ref: null,
    dirty: false,
    dirtyTreeHash: null,
    files: [
      {
        path: prefix && prefix !== '.' ? `${prefix}/${rel}` : rel,
        op: 'modified',
        addedLines: 0,
        removedLines: 0,
        hunks: [{ start: node.span.start, end: Math.max(node.span.start, node.span.end) }],
      },
    ],
    remote: remoteRaw && remoteRaw.status === 0 ? normalizeRemote(remoteRaw.stdout) : null,
  };
}

function dedupe(nodes: GraphNode[]): GraphNode[] {
  const seen = new Set<string>();
  return nodes.filter((n) => (seen.has(n.id) ? false : (seen.add(n.id), true)));
}

/** Build and validate the explain document for one symbol. */
export function buildExplainDoc(o: ExplainOptions): BuiltExplainDoc {
  const { root, graph, node } = o;
  const run = o.run ?? defaultRun;
  const change = explainChange(root, node, run);
  const sides = { inPlace: true };
  const resolve = makePinResolver(change, sides, run);
  const prefix = mapPrefix(change, root);
  const repoPath = (file: string) => (prefix ? `${prefix}/${file.replace(/\\/g, '/')}` : file.replace(/\\/g, '/'));
  /** `name` linked to its declaration when the pin lands, else plain code. */
  const linked = (n: GraphNode) => {
    const p = repoPath(n.file);
    const lines = resolve('head', p);
    const end = Math.max(n.span.start, n.span.end);
    // A link label stays plain text: renderers do not format inside it.
    return lines !== null && n.span.start >= 1 && end <= lines
      ? `[${n.qualifiedName.replace(/[[\]`]/g, '')}](${pinLink({ side: 'head', path: p, start: n.span.start, end })})`
      : `\`${n.qualifiedName.replace(/`/g, "'")}\``;
  };

  const sidecar = readHaileSidecar(resolveGraphPath(root, o.graphPath));
  const index = indexFor(graph);
  const callers = dedupe(index.callers(node.id).map((x) => x.node));
  const callees = dedupe(index.callees(node.id).map((x) => x.node));
  const area = graph.areas.find((a) => a.id === node.area);
  const role = rolesOf(graph, sidecar).get(node.id);

  const what: string[] = [`${linked(node)} is a ${node.kind} in \`${repoPath(node.file)}\`.`];
  if (node.signature) what.push('', `\`${node.signature.replace(/`/g, "'").replace(/\s+/g, ' ')}\``);
  const facts: string[] = [];
  if (role && role.role !== 'unknown') facts.push(`architecture role: ${role.role.replace(/_/g, ' ')}`);
  if (area) facts.push(`area: ${mdEscape(area.label)}`);
  facts.push(`${plural(callers.length, 'caller')}, ${plural(callees.length, 'callee')}`);
  if (node.tested !== undefined) facts.push(node.tested ? 'reached by tests' : 'not reached by tests');
  what.push('', facts.join(' · '));

  const models = readDataModels(change, sides, run);
  const overview = sidecar ? overviewOf(graph, sidecar, o.provider) : null;
  const system = change.remote ? (change.remote.split('/').pop() ?? '') : path.basename(change.topLevel);
  const design = deriveDiagrams(
    { change, head: graph, base: null, mapRoot: root, resolve, models, sidecar, overview, system, mode: 'explain' },
    o.provider,
  );

  const list = (heading: string, nodes: GraphNode[]): DocBlock | null => {
    if (nodes.length === 0) return null;
    const lines = [`**${heading}** (${nodes.length})`, '', ...nodes.slice(0, MAX_LISTED).map((n) => `- ${linked(n)}`)];
    if (nodes.length > MAX_LISTED) lines.push(`- +${nodes.length - MAX_LISTED} more — \`vg show ${node.qualifiedName}\` lists them`);
    return { type: 'markdown', text: lines.join('\n') };
  };
  const impl = [list('Called by', callers), list('Calls', callees)].filter((b): b is DocBlock => b !== null);

  const sections: DocSection[] = [{ kind: 'what_why', title: 'What it is', blocks: withIds([{ type: 'markdown', text: what.join('\n') }]) }];
  // Narrowed to some types, the first kept diagram leads when the primary was dropped.
  const kept = o.only ? design.blocks.filter((b) => o.only!.includes(b.type)) : design.blocks;
  const diagrams = kept.some((b) => (b as { primary?: boolean }).primary === true) ? kept : kept.map((b, i) => (i === 0 ? ({ ...b, primary: true } as DocBlock) : b));
  if (o.only && diagrams.length === 0) {
    throw new ExplainEmpty(`no ${o.only.join(' or ')} diagram for ${node.qualifiedName}: the code map records no steps for it — \`vg show ${node.qualifiedName} --diagram\` shows what there is`);
  }
  if (diagrams.length > 0) sections.push({ kind: 'design', title: 'How it works', blocks: withIds(diagrams) });
  if (impl.length > 0) sections.push({ kind: 'implementation', title: 'Callers and callees', blocks: withIds(impl) });

  const notes = ['explains the code as it is in the working tree; nothing here is a change', ...design.notes];
  const doc = sealReviewDoc({
    schema_version: DOC_SCHEMA,
    kind: 'explain',
    title: `Explain: ${node.qualifiedName}`.slice(0, 300),
    target: {
      repo_key: repoKey(change.remote, change.topLevel),
      base_sha: change.baseSha,
      head_sha: change.headSha,
      merge_base: null,
      dirty_tree_hash: null,
    },
    sections,
    groups_digest: null,
    generator: { by: 'vg', notes },
  });
  const issues = validateReviewDoc(doc, resolve);
  if (issues.length > 0) {
    throw new Error(`internal: generated explain document failed validation — ${issues[0].path}: ${issues[0].message}`);
  }
  return { doc, resolve };
}

export interface PathDocOptions {
  root: string;
  graph: VgGraph;
  path: PathResult;
  /** Whether the path follows call edges only (`vg path --calls`). */
  callsOnly: boolean;
  run?: GitRunner;
}

/**
 * The explain view of a path: how one piece of code reaches another, drawn as
 * one call path, caller first, each frame pinned to its declaration and each
 * hop to the line that makes it. Graph facts only: the path is the one
 * `vg path` finds, and nothing is judged.
 */
export function buildPathDoc(o: PathDocOptions): BuiltExplainDoc {
  const { root, graph } = o;
  const run = o.run ?? defaultRun;
  const byId = new Map(graph.nodes.map((n) => [n.id, n] as const));
  // A reverse path was found from B back to A; draw it in the order it runs.
  const ids = o.path.direction === 'forward' ? o.path.ids : [...o.path.ids].reverse();
  const nodes = ids.map((id) => byId.get(id)).filter((n): n is GraphNode => n !== undefined);
  if (nodes.length !== ids.length || nodes.length < 2) throw new Error('internal: the path names a node that is not in the code map');
  const first = nodes[0]!;
  const last = nodes[nodes.length - 1]!;
  const change = explainChange(root, first, run);
  const resolve = makePinResolver(change, { inPlace: true }, run);
  const prefix = mapPrefix(change, root);
  const repoPath = (file: string) => (prefix ? `${prefix}/${file.replace(/\\/g, '/')}` : file.replace(/\\/g, '/'));
  /** A pin for lines of a file, or null when it does not land in the working tree. */
  const pinOf = (file: string | undefined, start: number, end: number): Pin | null => {
    if (!file) return null;
    const p = repoPath(file);
    const lines = resolve('head', p);
    const e = Math.max(start, end);
    return lines !== null && start >= 1 && e <= lines ? { side: 'head', path: p, start, end: e } : null;
  };
  const hops = describeHops(graph, ids, 'forward');

  const frames: StackFrame[] = [];
  const unpinned: string[] = [];
  nodes.forEach((n, i) => {
    const pin = pinOf(n.file, n.span.start, n.span.end);
    if (!pin) {
      unpinned.push(n.qualifiedName);
      return;
    }
    const hop = i > 0 ? hops[i - 1] : undefined;
    const frame: StackFrame = { key: n.id, label: n.qualifiedName, pin };
    if (frames.length > 0) frame.parent_key = frames[frames.length - 1]!.key;
    if (hop?.kind === 'call') frame.via = { kind: hop.awaited ? 'async' : 'call' };
    const site = hop?.line ? pinOf(hop.file, hop.line, hop.line) : null;
    if (site) frame.call_site = site;
    frames.push(frame);
  });
  if (frames.length === 0) throw new ExplainEmpty('no step of this path has code in the working tree to pin, so there is nothing to draw');

  const name = (n: GraphNode) => {
    const pin = pinOf(n.file, n.span.start, n.span.end);
    const label = n.qualifiedName.replace(/[[\]`]/g, '');
    return pin ? `[${label}](${pinLink(pin)})` : `\`${n.qualifiedName.replace(/`/g, "'")}\``;
  };
  const steps = hops.map((h, i) => {
    const site = h.line ? pinOf(h.file, h.line, h.line) : null;
    const how = [h.kind === 'call' ? (h.awaited ? 'awaited call' : 'call') : h.kind, site ? `at [line ${h.line}](${pinLink(site)})` : null]
      .filter(Boolean)
      .join(' ');
    return `${i + 1}. ${name(nodes[i]!)} → ${name(nodes[i + 1]!)} · ${how}`;
  });
  const what = [
    `How ${name(first)} reaches ${name(last)}: ${plural(hops.length, 'hop')}, ${o.callsOnly ? 'following calls only' : 'over any relation in the code map (add --calls to follow calls only)'}.`,
    '',
    ...steps,
  ];

  const sections: DocSection[] = [
    { kind: 'what_why', title: 'What it is', blocks: withIds([{ type: 'markdown', text: what.join('\n') }]) },
    {
      kind: 'design',
      title: 'How it works',
      blocks: withIds([
        { type: 'call_stack_diff', title: `How ${first.qualifiedName} reaches ${last.qualifiedName}`.slice(0, 300), primary: true, base_status: 'not_computed', base: [], head: frames },
      ]),
    },
  ];
  const notes = ['explains the code as it is in the working tree; nothing here is a change', `the path ${o.callsOnly ? 'follows call edges only' : 'is the shortest over any edge'}, as \`vg path\` finds it`];
  if (unpinned.length > 0) notes.push(`left out of the call path, with no code in the working tree to pin: ${unpinned.join(', ')}`);
  const doc = sealReviewDoc({
    schema_version: DOC_SCHEMA,
    kind: 'explain',
    title: `Path: ${first.qualifiedName} → ${last.qualifiedName}`.slice(0, 300),
    target: { repo_key: repoKey(change.remote, change.topLevel), base_sha: change.baseSha, head_sha: change.headSha, merge_base: null, dirty_tree_hash: null },
    sections,
    groups_digest: null,
    generator: { by: 'vg', notes },
  });
  const issues = validateReviewDoc(doc, resolve);
  if (issues.length > 0) throw new Error(`internal: generated path document failed validation — ${issues[0].path}: ${issues[0].message}`);
  return { doc, resolve };
}
