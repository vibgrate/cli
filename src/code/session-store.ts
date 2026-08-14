/**
 * Session persistence for VG Code (VG-CLI-CODE §16) — `vg code --continue`.
 *
 * A coding session is a series of tasks; this stores each turn's instruction and
 * final answer (plus which files changed) and the last change-set so `/undo`
 * survives a restart. History → pick reloads those turns into the panel so the
 * user can re-read the full thread. `--continue` reloads the most recent session
 * and seeds the model with a *short recap* of prior turns (see
 * {@link summarizeSession}) — never raw file bodies or tool transcripts.
 *
 * Pure over an injected clock; the store is JSON under `.vibgrate/code-sessions/`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { FileChange } from './types.js';

/**
 * What was attached to a turn, as METADATA only — name, kind, size. The bytes
 * are deliberately absent: a session file that carried a 20 MiB screenshot
 * would be unreadable, unsyncable, and would blow the History index it feeds.
 * A restored chat shows what was attached, not the attachment itself.
 */
export interface SessionAttachment {
  name: string;
  kind: 'image' | 'text';
  mediaType?: string;
  bytes?: number;
}

export interface SessionTask {
  instruction: string;
  summary: string;
  files: string[];
  stopped: string;
  ts: number;
  /** v5: what the user attached to this turn (metadata only). */
  attachments?: SessionAttachment[];
}

export interface StoredSession {
  id: string;
  provider: string;
  model: string;
  startedAt: number;
  updatedAt: number;
  /** User-chosen chat name (rename). Absent → derived from the first task. */
  title?: string;
  /** Set when this chat was forked from another (History shows the lineage). */
  forkedFrom?: string;
  /** Set when this chat runs in an isolated git worktree (P3 worktree sessions). */
  worktree?: { id: string; path: string; base: string };
  tasks: SessionTask[];
  /** The most recent change-set, so `/undo` works after `--continue`. */
  lastChanges: FileChange[];
}

export function sessionsDir(root: string): string {
  return path.join(root, '.vibgrate', 'code-sessions');
}
function latestPointer(root: string): string {
  return path.join(sessionsDir(root), 'latest.json');
}
function indexFile(root: string): string {
  return path.join(sessionsDir(root), 'index.json');
}

/** One row of the History index — everything a list UI needs, no session parse. */
export interface SessionIndexEntry {
  id: string;
  provider: string;
  model: string;
  startedAt: number;
  updatedAt: number;
  taskCount: number;
  title: string;
  forkedFrom?: string;
  /** Set when the chat runs in an isolated worktree (History shows a WT badge). */
  worktreeId?: string;
}

/** The derived list title: explicit rename wins, else the first instruction. */
export function sessionTitle(session: Pick<StoredSession, 'title' | 'tasks'>): string {
  const explicit = session.title?.trim();
  if (explicit) return explicit.slice(0, 80);
  return (session.tasks?.[0]?.instruction?.trim() || 'New chat').slice(0, 80);
}

function toIndexEntry(session: StoredSession): SessionIndexEntry {
  return {
    id: session.id,
    provider: session.provider ?? '',
    model: session.model ?? '',
    startedAt: session.startedAt ?? 0,
    updatedAt: session.updatedAt ?? session.startedAt ?? 0,
    taskCount: session.tasks.length,
    title: sessionTitle(session),
    ...(session.forkedFrom ? { forkedFrom: session.forkedFrom } : {}),
    ...(session.worktree ? { worktreeId: session.worktree.id } : {}),
  };
}

/**
 * Read the History index, or null when absent/unreadable. The index is a
 * best-effort cache maintained on every save/rename/delete: History UIs read
 * one small file instead of parsing every stored session (whose summaries can
 * run to 200k chars each). A missing or stale index is never an error — list
 * paths fall back to the full directory scan and rewrite it.
 */
export function readSessionIndex(root: string): SessionIndexEntry[] | null {
  try {
    const raw = JSON.parse(fs.readFileSync(indexFile(root), 'utf8')) as {
      sessions?: SessionIndexEntry[];
    };
    if (!Array.isArray(raw?.sessions)) return null;
    return raw.sessions.filter((s) => s && typeof s.id === 'string' && typeof s.title === 'string');
  } catch {
    return null;
  }
}

function writeSessionIndex(root: string, entries: SessionIndexEntry[]): void {
  try {
    fs.mkdirSync(sessionsDir(root), { recursive: true });
    fs.writeFileSync(indexFile(root), JSON.stringify({ sessions: entries }, null, 2));
  } catch {
    /* best-effort cache */
  }
}

/** Upsert one session's index row (called from every save). */
function updateSessionIndex(root: string, session: StoredSession): void {
  const entries = readSessionIndex(root) ?? rebuildSessionIndex(root);
  const next = entries.filter((e) => e.id !== session.id);
  next.push(toIndexEntry(session));
  next.sort((a, b) => b.updatedAt - a.updatedAt);
  writeSessionIndex(root, next);
}

/** Rebuild the index from the stored files (missing/corrupt index, migrations). */
export function rebuildSessionIndex(root: string): SessionIndexEntry[] {
  const entries: SessionIndexEntry[] = [];
  try {
    const dir = sessionsDir(root);
    if (!fs.existsSync(dir)) return entries;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json') || f === 'latest.json' || f === 'index.json') continue;
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as StoredSession;
        if (raw?.id && Array.isArray(raw.tasks)) entries.push(toIndexEntry(raw));
      } catch {
        /* skip bad file */
      }
    }
  } catch {
    /* no dir */
  }
  entries.sort((a, b) => b.updatedAt - a.updatedAt);
  return entries;
}

/** Write a session and update the `latest` pointer + index. Best-effort; never throws. */
export function saveSession(root: string, session: StoredSession): void {
  try {
    const dir = sessionsDir(root);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${session.id}.json`), JSON.stringify(session, null, 2));
    fs.writeFileSync(latestPointer(root), JSON.stringify({ id: session.id }));
    updateSessionIndex(root, session);
  } catch {
    /* persistence is best-effort */
  }
}

/*
 * NOTE: rename/delete/fork/rewind below are the store's REFERENCE mutations.
 * The VS Code extension mirrors them over the same files
 * (packages/vibgrate-vscode/src/codeSessionHistory.ts) because it cannot link
 * this library — a semantic change must land on both sides, and the
 * extension's protocol-conformance test pins the shared index.json shape.
 */

/**
 * Rename a stored chat. Empty title clears the rename (back to the derived
 * name). Returns false when the session does not exist or the write failed.
 */
export function renameSession(root: string, id: string, title: string): boolean {
  const s = loadSession(root, id);
  if (!s) return false;
  const t = title.trim().slice(0, 120);
  const next: StoredSession = { ...s };
  if (t) next.title = t;
  else delete next.title;
  try {
    fs.writeFileSync(path.join(sessionsDir(root), `${next.id}.json`), JSON.stringify(next, null, 2));
    updateSessionIndex(root, next);
    return true;
  } catch {
    return false;
  }
}

/**
 * Delete a stored chat (and its index row). The `latest` pointer is cleared
 * when it referenced the deleted chat, so `--continue` cannot resume a ghost.
 */
export function deleteSession(root: string, id: string): boolean {
  const safe = id.replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safe || safe !== id) return false;
  const file = path.join(sessionsDir(root), `${safe}.json`);
  if (!fs.existsSync(file)) return false;
  try {
    fs.unlinkSync(file);
  } catch {
    return false;
  }
  const entries = (readSessionIndex(root) ?? rebuildSessionIndex(root)).filter((e) => e.id !== safe);
  writeSessionIndex(root, entries);
  try {
    const { id: latest } = JSON.parse(fs.readFileSync(latestPointer(root), 'utf8')) as { id: string };
    if (latest === safe) fs.unlinkSync(latestPointer(root));
  } catch {
    /* no pointer */
  }
  return true;
}

/**
 * Fork a stored chat: copy it under a fresh id, renamed "(Fork) <title>", so
 * the user can explore an alternative continuation without losing the original.
 * Returns the new session, or undefined when the source is missing/unwritable.
 */
export function forkSession(
  root: string,
  id: string,
  newId: string,
  now: number,
): StoredSession | undefined {
  const src = loadSession(root, id);
  if (!src) return undefined;
  const fork: StoredSession = {
    ...src,
    id: newId,
    title: `(Fork) ${sessionTitle(src)}`.slice(0, 120),
    forkedFrom: src.id,
    updatedAt: now,
  };
  try {
    const dir = sessionsDir(root);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${newId}.json`), JSON.stringify(fork, null, 2));
    updateSessionIndex(root, fork);
    return fork;
  } catch {
    return undefined;
  }
}

/**
 * Rewind a stored chat to its first `keepTurns` tasks (0 empties it). The
 * discarded turns are gone from the recap the next launch seeds — pair with
 * checkpoint restores to also rewind the files. Returns the rewound session,
 * or undefined when the session is missing or `keepTurns` is not a rewind.
 */
export function rewindSession(
  root: string,
  id: string,
  keepTurns: number,
  now: number,
): StoredSession | undefined {
  const s = loadSession(root, id);
  if (!s) return undefined;
  const keep = Math.floor(keepTurns);
  if (keep < 0 || keep >= s.tasks.length) return undefined;
  const next: StoredSession = { ...s, tasks: s.tasks.slice(0, keep), updatedAt: now, lastChanges: [] };
  try {
    fs.writeFileSync(path.join(sessionsDir(root), `${next.id}.json`), JSON.stringify(next, null, 2));
    updateSessionIndex(root, next);
    return next;
  } catch {
    return undefined;
  }
}

/** Load the most recent session, or undefined if none/there was a read error. */
export function loadLatestSession(root: string): StoredSession | undefined {
  try {
    const { id } = JSON.parse(fs.readFileSync(latestPointer(root), 'utf8')) as { id: string };
    return loadSession(root, id);
  } catch {
    /* no session */
  }
  return undefined;
}

/**
 * True for a string shaped like a minted session id (see `sessionId()` in
 * interactive.ts: exactly ten lowercase `[a-z0-9]` characters). `--continue`
 * takes an optional id, and commander cannot tell an id from the first word of
 * an instruction (`vg code --continue fix the tests` hands the parser
 * `continue="fix"`) — callers use this shape test to fold anything else back
 * into the instruction instead of losing it to a doomed session lookup.
 */
export function looksLikeSessionId(v: string): boolean {
  return /^[a-z0-9]{10}$/.test(v);
}

/** Load one session by id, or undefined if missing/invalid. */
export function loadSession(root: string, id: string): StoredSession | undefined {
  try {
    const safe = id.replace(/[^a-zA-Z0-9_-]/g, '');
    if (!safe || safe !== id) return undefined;
    const raw = JSON.parse(fs.readFileSync(path.join(sessionsDir(root), `${safe}.json`), 'utf8')) as StoredSession;
    if (Array.isArray(raw.tasks) && raw.id) return raw;
  } catch {
    /* missing */
  }
  return undefined;
}

export type SessionListEntry = SessionIndexEntry;

/**
 * List stored sessions newest-first (multi-chat history). Served from the
 * index when one exists; otherwise a full scan that also rewrites the index
 * so the next list is cheap. Best-effort.
 */
export function listSessions(root: string, limit = 50): SessionListEntry[] {
  const indexed = readSessionIndex(root);
  if (indexed) {
    return [...indexed].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, Math.max(1, limit));
  }
  const scanned = rebuildSessionIndex(root);
  if (scanned.length) writeSessionIndex(root, scanned);
  return scanned.slice(0, Math.max(1, limit));
}

/** Point `latest` at an existing session (resume a prior chat). */
export function setLatestSession(root: string, id: string): boolean {
  const s = loadSession(root, id);
  if (!s) return false;
  try {
    fs.mkdirSync(sessionsDir(root), { recursive: true });
    fs.writeFileSync(latestPointer(root), JSON.stringify({ id: s.id }));
    return true;
  } catch {
    return false;
  }
}

/**
 * Cap stored fields so a runaway answer cannot fill the disk, while still
 * keeping enough of each prompt/answer for History → reload to repaint the
 * full panel transcript (the old 300-char cap cut answers mid-sentence).
 */
const MAX_INSTRUCTION_CHARS = 32_000;
const MAX_SUMMARY_CHARS = 200_000;

/** Truncate for model recaps only — disk storage keeps the longer form. */
function recapSnippet(text: string, max: number): string {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + '…';
}

/** A short natural-language recap of a session to seed a continued run's context. */
export function summarizeSession(session: StoredSession): string {
  if (session.tasks.length === 0) return '';
  const lines = session.tasks.slice(-8).map((t, i) => {
    const instr = recapSnippet(t.instruction, 120);
    const sum = recapSnippet(t.summary, 200);
    const files = t.files.length ? ` (${t.files.join(', ')})` : '';
    return `${i + 1}. ${instr} — ${sum}${files}`;
  });
  return `Earlier in this session (${session.provider}/${session.model}) you did:\n${lines.join('\n')}`;
}

/** A fresh session record. `id` and `now` are injected so this stays deterministic. */
export function newSession(id: string, provider: string, model: string, now: number): StoredSession {
  return { id, provider, model, startedAt: now, updatedAt: now, tasks: [], lastChanges: [] };
}

/**
 * Manually compact a session: collapse all recorded tasks into a single
 * checkpoint entry so the recap seeded into future turns shrinks to one line
 * per prior task, capped. Deterministic (no model call) — the in-turn LLM
 * compaction handles rich summaries; this is the user-invoked `/compact`.
 */
export function condenseSession(session: StoredSession, now: number): StoredSession {
  if (session.tasks.length <= 1) return session;
  const files = [...new Set(session.tasks.flatMap((t) => t.files))];
  const lines = session.tasks
    .slice(-12)
    .map((t) => `${t.instruction.slice(0, 80)} — ${t.summary.slice(0, 80)}`);
  const checkpoint: SessionTask = {
    instruction: `(compacted: ${session.tasks.length} earlier task(s))`,
    summary: lines.join(' · ').slice(0, 1500),
    files,
    stopped: 'compacted',
    ts: now,
  };
  return { ...session, updatedAt: now, tasks: [checkpoint] };
}

/** Append a completed task (immutably updating the record's timestamps). */
export function recordTask(
  session: StoredSession,
  task: {
    instruction: string;
    summary: string;
    changes: FileChange[];
    stopped: string;
    attachments?: SessionAttachment[];
  },
  now: number,
): StoredSession {
  const files = [...new Set(task.changes.map((c) => c.file))];
  const instruction = String(task.instruction ?? '').slice(0, MAX_INSTRUCTION_CHARS);
  const summary = String(task.summary ?? '').slice(0, MAX_SUMMARY_CHARS);
  const attachments = sanitizeAttachments(task.attachments);
  return {
    ...session,
    updatedAt: now,
    tasks: [
      ...session.tasks,
      {
        instruction,
        summary,
        files,
        stopped: task.stopped,
        ts: now,
        ...(attachments.length ? { attachments } : {}),
      },
    ],
    lastChanges: task.changes.length ? task.changes : session.lastChanges,
  };
}

/** Metadata only, capped and name-trimmed — never any file content. */
export function sanitizeAttachments(raw: unknown): SessionAttachment[] {
  if (!Array.isArray(raw)) return [];
  const out: SessionAttachment[] = [];
  for (const a of raw.slice(0, 8)) {
    if (!a || typeof a !== 'object') continue;
    const r = a as Record<string, unknown>;
    const name = typeof r.name === 'string' ? r.name.trim().slice(0, 120) : '';
    if (!name) continue;
    const kind = r.kind === 'image' ? 'image' : 'text';
    const mediaType = typeof r.mediaType === 'string' ? r.mediaType.slice(0, 80) : undefined;
    const bytes = typeof r.bytes === 'number' && Number.isFinite(r.bytes) && r.bytes >= 0 ? r.bytes : undefined;
    out.push({ name, kind, ...(mediaType ? { mediaType } : {}), ...(bytes !== undefined ? { bytes } : {}) });
  }
  return out;
}
