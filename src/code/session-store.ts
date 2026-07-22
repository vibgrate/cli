/**
 * Session persistence for VG Code (VG-CLI-CODE §16) — `vg code --continue`.
 *
 * A coding session is a series of tasks; this stores a compact record of them
 * (what you asked, a one-line outcome, which files changed) plus the last
 * change-set so `/undo` survives a restart. `--continue` reloads the most recent
 * session and hands the model a short summary of what was already done, so you
 * can pick a conversation back up instead of re-explaining. We persist a
 * *summary*, never raw file contents or tool transcripts — small, private, and
 * safe to keep on disk.
 *
 * Pure over an injected clock; the store is JSON under `.vibgrate/code-sessions/`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { FileChange } from './types.js';

export interface SessionTask {
  instruction: string;
  summary: string;
  files: string[];
  stopped: string;
  ts: number;
}

export interface StoredSession {
  id: string;
  provider: string;
  model: string;
  startedAt: number;
  updatedAt: number;
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

/** Write a session and update the `latest` pointer. Best-effort; never throws. */
export function saveSession(root: string, session: StoredSession): void {
  try {
    const dir = sessionsDir(root);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${session.id}.json`), JSON.stringify(session, null, 2));
    fs.writeFileSync(latestPointer(root), JSON.stringify({ id: session.id }));
  } catch {
    /* persistence is best-effort */
  }
}

/** Load the most recent session, or undefined if none/there was a read error. */
export function loadLatestSession(root: string): StoredSession | undefined {
  try {
    const { id } = JSON.parse(fs.readFileSync(latestPointer(root), 'utf8')) as { id: string };
    const raw = JSON.parse(fs.readFileSync(path.join(sessionsDir(root), `${id}.json`), 'utf8')) as StoredSession;
    if (Array.isArray(raw.tasks)) return raw;
  } catch {
    /* no session */
  }
  return undefined;
}

/** A short natural-language recap of a session to seed a continued run's context. */
export function summarizeSession(session: StoredSession): string {
  if (session.tasks.length === 0) return '';
  const lines = session.tasks.slice(-8).map((t, i) => `${i + 1}. ${t.instruction} — ${t.summary}${t.files.length ? ` (${t.files.join(', ')})` : ''}`);
  return `Earlier in this session (${session.provider}/${session.model}) you did:\n${lines.join('\n')}`;
}

/** A fresh session record. `id` and `now` are injected so this stays deterministic. */
export function newSession(id: string, provider: string, model: string, now: number): StoredSession {
  return { id, provider, model, startedAt: now, updatedAt: now, tasks: [], lastChanges: [] };
}

/** Append a completed task (immutably updating the record's timestamps). */
export function recordTask(
  session: StoredSession,
  task: { instruction: string; summary: string; changes: FileChange[]; stopped: string },
  now: number,
): StoredSession {
  const files = [...new Set(task.changes.map((c) => c.file))];
  return {
    ...session,
    updatedAt: now,
    tasks: [...session.tasks, { instruction: task.instruction.slice(0, 300), summary: task.summary.slice(0, 300), files, stopped: task.stopped, ts: now }],
    lastChanges: task.changes.length ? task.changes : session.lastChanges,
  };
}
