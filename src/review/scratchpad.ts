/**
 * The explain scratchpad: one always-present document per repository for
 * understanding code as it is, not for reviewing a change.
 *
 * Every explanation kept here (`vg show <name> --diagram --keep`,
 * `vg path <a> <b> --diagram --keep`, `review_doc` op "explain" with `keep`)
 * lands on top, newest first. An entry starts with a `####` heading block and
 * runs to the next one; keeping the same explanation again moves it to the
 * top rather than adding a copy. An agent patches blocks by id with the same
 * operations as a review document, and its words are marked `origin: agent`.
 *
 * It is a `vg.review.doc.v1` document with `kind: "explain"`, so the
 * validator, renderers and the VS Code tab are shared. Every pin points at
 * the working tree. Code moves under a scratchpad, so a block whose pins no
 * longer land is reported, never silently dropped, and only new breakage
 * refuses a patch.
 *
 * Stored in `.vibgrate/review-docs/scratchpad.json`, never committed. Same
 * retention as a review document (GUARDRAILS §1.7, Repository, 365 days): a
 * scratchpad not updated for 365 days is deleted the next time it is read.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { ensureVibgrateGitignore } from '../engine/artifacts.js';
import { applyPatch, RETENTION_DAYS } from './doc-store.js';
import {
  blockId,
  DOC_SCHEMA,
  makePinResolver,
  sealReviewDoc,
  validateReviewDoc,
  type DocBlock,
  type DocIssue,
  type PinResolver,
  type ReviewDoc,
} from './doc.js';
import { defaultRun, gitTopLevel, isGitRepo, normalizeRemote, repoKey, type ChangeSet, type GitRunner } from './git.js';

export const SCRATCHPAD_SCHEMA = 'vg.review.scratchpad.v1' as const;
/** The id `review_doc` uses for the scratchpad, beside `rd_…` review documents. */
export const SCRATCHPAD_ID = 'scratchpad';
/** Entries kept; the oldest go first. */
export const MAX_ENTRIES = 30;

const DIAGRAMS = new Set(['flow', 'sequence', 'call_stack_diff', 'data_store', 'system_map']);

interface StoredScratchpad {
  schema: typeof SCRATCHPAD_SCHEMA;
  version: number;
  updated_at: string;
  /** Null when empty: a document needs at least one block. */
  doc: ReviewDoc | null;
}

export interface Scratchpad {
  doc_id: typeof SCRATCHPAD_ID;
  version: number;
  updated_at: string | null;
  doc: ReviewDoc | null;
  /** Pins that no longer land in the working tree, by block. */
  stale: { block: string; message: string }[];
}

export type Clock = () => Date;
const systemClock: Clock = () => new Date();

/** Where a repository's scratchpad lives: its top level, so every subdirectory shares one. */
function homeOf(root: string, run: GitRunner): string {
  return isGitRepo(root, run) ? gitTopLevel(root, run) : root;
}

function fileOf(top: string): string {
  return path.join(top, '.vibgrate', 'review-docs', 'scratchpad.json');
}

/** The working tree as a change of nothing: pins resolve against files as they are. */
function workingTree(top: string, run: GitRunner): ChangeSet {
  const git = isGitRepo(top, run);
  const head = git ? run(['rev-parse', 'HEAD'], top).stdout.trim() : '';
  const remote = git ? run(['config', '--get', 'remote.origin.url'], top) : null;
  const sha = head || 'working-tree';
  return {
    topLevel: top,
    baseSha: sha,
    headSha: sha,
    mergeBase: null,
    ref: null,
    dirty: false,
    dirtyTreeHash: null,
    files: [],
    remote: remote && remote.status === 0 ? normalizeRemote(remote.stdout) : null,
  };
}

function read(top: string, clock: Clock): StoredScratchpad | null {
  const file = fileOf(top);
  let stored: StoredScratchpad;
  try {
    stored = JSON.parse(fs.readFileSync(file, 'utf8')) as StoredScratchpad;
  } catch {
    return null;
  }
  if (stored?.schema !== SCRATCHPAD_SCHEMA || typeof stored.version !== 'number') return null;
  if (Date.parse(stored.updated_at) < clock().getTime() - RETENTION_DAYS * 86_400_000) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* the next read tries again */
    }
    return null;
  }
  return stored;
}

function write(top: string, stored: StoredScratchpad): void {
  const file = fileOf(top);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  ensureVibgrateGitignore(top);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(stored, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

const isHeading = (b: DocBlock) => b.type === 'markdown' && /^#### /.test((b as { text: string }).text);
const blocksOf = (doc: ReviewDoc | null): DocBlock[] => (doc ? doc.sections.flatMap((s) => s.blocks) : []);

/** Entries, newest first: a heading block and everything up to the next one. */
export function entriesOf(blocks: DocBlock[]): DocBlock[][] {
  const out: DocBlock[][] = [];
  for (const b of blocks) {
    if (isHeading(b) || out.length === 0) out.push([b]);
    else out[out.length - 1]!.push(b);
  }
  return out;
}

/**
 * Lay blocks out as a valid explain document: one design section with
 * exactly one primary diagram (the agent's choice if there is exactly one,
 * else the topmost diagram), or a what-and-why section when there are no
 * diagrams at all.
 */
function compose(blocks: DocBlock[], change: ChangeSet, title = 'Scratchpad'): ReviewDoc | null {
  if (blocks.length === 0) return null;
  const diagrams = blocks.filter((b) => DIAGRAMS.has(b.type));
  const primaries = blocks.filter((b) => (b as { primary?: boolean }).primary === true);
  const keep = primaries.length === 1 && DIAGRAMS.has(primaries[0]!.type) ? primaries[0] : diagrams[0];
  const laid = blocks.map((b) => {
    const { primary: _p, ...rest } = b as DocBlock & { primary?: boolean };
    return (b === keep ? { ...rest, primary: true } : rest) as DocBlock;
  });
  return sealReviewDoc({
    schema_version: DOC_SCHEMA,
    kind: 'explain',
    title,
    target: { repo_key: repoKey(change.remote, change.topLevel), base_sha: change.baseSha, head_sha: change.headSha, merge_base: null, dirty_tree_hash: null },
    sections: [{ kind: diagrams.length > 0 ? 'design' : 'what_why', title: 'Scratchpad', blocks: laid }],
    groups_digest: null,
    generator: { by: 'vg', notes: ['explains code as it is in the working tree, newest on top; nothing here is a change'] },
  });
}

/** The id of the block an issue is in, or the issue's path when it is in none. */
function blockOfIssue(doc: ReviewDoc | null, issue: DocIssue): string {
  const m = /^\$\.sections\[(\d+)\]\.blocks\[(\d+)\]/.exec(issue.path);
  const block = m && doc ? doc.sections[Number(m[1])]?.blocks[Number(m[2])] : undefined;
  return block?.id ?? issue.path;
}

function staleOf(doc: ReviewDoc | null, resolve: PinResolver): { stale: { block: string; message: string }[]; issues: DocIssue[] } {
  if (!doc) return { stale: [], issues: [] };
  const issues = validateReviewDoc(doc, resolve);
  const byBlock = new Map<string, string>();
  for (const i of issues) {
    const block = blockOfIssue(doc, i);
    if (!byBlock.has(block)) byBlock.set(block, i.message);
  }
  return { stale: [...byBlock].map(([block, message]) => ({ block, message })), issues };
}

/** The scratchpad as it is, with any blocks whose pins no longer land. */
export function getScratchpad(root: string, o: { run?: GitRunner; clock?: Clock } = {}): Scratchpad {
  const run = o.run ?? defaultRun;
  const top = homeOf(root, run);
  const stored = read(top, o.clock ?? systemClock);
  if (!stored) return { doc_id: SCRATCHPAD_ID, version: 0, updated_at: null, doc: null, stale: [] };
  const resolve = makePinResolver(workingTree(top, run), { inPlace: true }, run);
  return { doc_id: SCRATCHPAD_ID, version: stored.version, updated_at: stored.updated_at, doc: stored.doc, stale: staleOf(stored.doc, resolve).stale };
}

/** Block ids unique against those already in the scratchpad. */
function freshIds(blocks: DocBlock[], taken: Set<string>): DocBlock[] {
  return blocks.map((b) => {
    const base = b.id ?? blockId(b);
    let id = base;
    for (let n = 1; taken.has(id); n++) id = `${base}_${n}`;
    taken.add(id);
    return { ...b, id };
  });
}

/**
 * Keep an explain document on top of the scratchpad. Its title becomes the
 * entry heading, its first section's text follows, then its diagrams. The
 * same title kept again replaces the older entry.
 */
export function keepInScratchpad(root: string, explained: ReviewDoc, o: { run?: GitRunner; clock?: Clock } = {}): Scratchpad {
  const run = o.run ?? defaultRun;
  const clock = o.clock ?? systemClock;
  const top = homeOf(root, run);
  const stored = read(top, clock);
  const heading = `#### ${explained.title.replace(/\s+/g, ' ')}`;
  const older = entriesOf(blocksOf(stored?.doc ?? null)).filter((e) => (e[0] as { text?: string }).text !== heading);
  const kept = older.slice(0, MAX_ENTRIES - 1).flat();
  const taken = new Set(kept.map((b) => b.id ?? ''));
  const body = explained.sections.flatMap((s) => s.blocks).map((b) => {
    const { primary: _p, id: _id, ...rest } = b as DocBlock & { primary?: boolean };
    return rest as DocBlock;
  });
  const entry = freshIds([{ type: 'markdown', text: heading } as DocBlock, ...body], taken);
  const change = workingTree(top, run);
  const doc = compose([...entry, ...kept], change, stored?.doc?.title);
  const next: StoredScratchpad = { schema: SCRATCHPAD_SCHEMA, version: (stored?.version ?? 0) + 1, updated_at: clock().toISOString(), doc };
  write(top, next);
  return getScratchpad(root, o);
}

export type ScratchpadPatch =
  | { ok: true; scratchpad: Scratchpad; notes: string[] }
  | { ok: false; version: number; conflict?: boolean; errors: string[]; issues: DocIssue[] };

/**
 * Patch the scratchpad by block id, with the review document's operations.
 * All or nothing, against the version the writer read. Refused when the
 * result has a new problem; a block that was already stale may stay stale.
 */
export function patchScratchpad(root: string, expect: number, ops: unknown, o: { run?: GitRunner; clock?: Clock } = {}): ScratchpadPatch {
  const run = o.run ?? defaultRun;
  const clock = o.clock ?? systemClock;
  const top = homeOf(root, run);
  const stored = read(top, clock);
  const version = stored?.version ?? 0;
  if (expect !== version) {
    return { ok: false, version, conflict: true, errors: [`written against version ${expect}; the scratchpad is at version ${version} — read it again and reapply`], issues: [] };
  }
  if (!stored?.doc) return { ok: false, version, errors: ['the scratchpad is empty — keep an explanation first (op "explain" with keep: true)'], issues: [] };
  const change = workingTree(top, run);
  const resolve = makePinResolver(change, { inPlace: true }, run);
  const result = applyPatch(stored.doc, ops);
  if (result.errors.length > 0) return { ok: false, version, errors: result.errors, issues: [] };
  const doc = compose(blocksOf(result.doc), change, result.doc.title);
  const before = new Set(staleOf(stored.doc, resolve).stale.map((s) => s.block));
  const after = staleOf(doc, resolve);
  const fresh = after.issues.filter((i) => !before.has(blockOfIssue(doc, i)));
  if (fresh.length > 0) return { ok: false, version, errors: [], issues: fresh };
  write(top, { schema: SCRATCHPAD_SCHEMA, version: version + 1, updated_at: clock().toISOString(), doc });
  return { ok: true, scratchpad: getScratchpad(root, o), notes: result.notes };
}

/** Empty the scratchpad. Returns the version it was at. */
export function clearScratchpad(root: string, o: { run?: GitRunner } = {}): number {
  const run = o.run ?? defaultRun;
  const top = homeOf(root, run);
  const stored = read(top, systemClock);
  try {
    fs.rmSync(fileOf(top), { force: true });
  } catch {
    /* nothing to clear */
  }
  return stored?.version ?? 0;
}

/** Where the scratchpad file is, for a watcher (VS Code reloads its tab when it changes). */
export function scratchpadFile(root: string, run: GitRunner = defaultRun): string {
  return fileOf(homeOf(root, run));
}
