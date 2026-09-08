/**
 * OpenCode sessions from its JSON storage:
 *   `$XDG_DATA_HOME|~/.local/share/opencode/storage/session/<projectID>/<sessionID>.json`
 *   `…/storage/message/<sessionID>/<messageID>.json`
 *   `…/storage/part/<messageID>/<partID>.json`   (tool parts: `{type:'tool', tool, callID, state:{status,input,output}}`)
 *
 * The SQLite database newer builds also keep is not read (vg carries no
 * SQLite dependency); the JSON storage is the durable, agent-agnostic form.
 */

import * as path from 'node:path';
import { homeDir, isDir, listDir, parseTimestamp, readJson, stringifyOutput } from '../shared.js';
import type { ScanOptions, Scanner, Session } from '../types.js';
import { SessionBuilder } from './common.js';

const ERROR_STATUSES = new Set(['error', 'failed', 'aborted']);

export function opencodeDataDir(env: NodeJS.ProcessEnv = process.env, home?: string): string {
  const xdg = env.XDG_DATA_HOME?.trim();
  return path.join(xdg ? path.resolve(xdg) : path.join(homeDir(env, home), '.local', 'share'), 'opencode');
}

function readObj(file: string): Record<string, unknown> | null {
  const v = readJson(file);
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function timeOf(obj: Record<string, unknown>, key: 'created' | 'updated' | 'completed'): number | undefined {
  const t = obj.time as Record<string, unknown> | undefined;
  return parseTimestamp(t?.[key]);
}

function scanSession(storage: string, sessionFile: string): Session | null {
  const session = readObj(sessionFile);
  if (!session || typeof session.id !== 'string') return null;
  const sid = session.id;
  const b = new SessionBuilder('opencode', sid, sessionFile);
  if (typeof session.directory === 'string' && path.isAbsolute(session.directory)) b.project = session.directory;
  b.noteTime(timeOf(session, 'created'));
  b.noteTime(timeOf(session, 'updated'));

  const messageDir = path.join(storage, 'message', sid);
  const messages: Record<string, unknown>[] = [];
  for (const name of listDir(messageDir)) {
    if (!name.endsWith('.json')) continue;
    const m = readObj(path.join(messageDir, name));
    if (m && typeof m.id === 'string') messages.push(m);
  }
  messages.sort((a, b2) => (timeOf(a, 'created') ?? 0) - (timeOf(b2, 'created') ?? 0) || String(a.id).localeCompare(String(b2.id)));

  for (const m of messages) {
    const mid = String(m.id);
    const ts = timeOf(m, 'created');
    const partDir = path.join(storage, 'part', mid);
    const parts: Record<string, unknown>[] = [];
    for (const name of listDir(partDir)) {
      if (!name.endsWith('.json')) continue;
      const p = readObj(path.join(partDir, name));
      if (p) parts.push(p);
    }
    parts.sort((a, b2) => (timeOf(a, 'created') ?? 0) - (timeOf(b2, 'created') ?? 0) || String(a.id ?? '').localeCompare(String(b2.id ?? '')));
    const texts: string[] = [];
    let hasToolUse = false;
    for (const p of parts) {
      if (p.type === 'text' && typeof p.text === 'string') texts.push(p.text);
      if (p.type !== 'tool') continue;
      hasToolUse = true;
      const state = p.state && typeof p.state === 'object' ? (p.state as Record<string, unknown>) : {};
      const status = String(state.status ?? 'unknown').toLowerCase();
      const callId = typeof p.callID === 'string' && p.callID ? p.callID : `oc_${sid}_${mid}_${String(p.id ?? parts.indexOf(p))}`;
      const output = stringifyOutput(state.output ?? state.error ?? '');
      b.toolCall(callId, String(p.tool ?? 'unknown'), state.input ?? {}, output, ERROR_STATUSES.has(status), timeOf(p, 'created') ?? ts);
    }
    const tokens = m.tokens as Record<string, unknown> | undefined;
    const inTok = tokens && typeof tokens.input === 'number' ? tokens.input : 0;
    const outTok = tokens && typeof tokens.output === 'number' ? tokens.output : 0;
    if (m.role === 'user') b.user(texts.join('\n'), ts);
    else if (m.role === 'assistant') b.assistant(texts.join('\n'), { ts, inputTokens: inTok, outputTokens: outTok, hasToolUse });
  }
  return b.build();
}

export const opencodeScanner: Scanner = {
  agent: 'opencode',
  sessionsDir(env = process.env, home?) {
    return [path.join(opencodeDataDir(env, home), 'storage')];
  },
  scan(opts: ScanOptions): Session[] {
    const storage = this.sessionsDir(opts.env ?? process.env, opts.home)[0];
    const sessionRoot = path.join(storage, 'session');
    if (!isDir(sessionRoot)) return [];
    const out: Session[] = [];
    for (const projectId of listDir(sessionRoot)) {
      const dir = path.join(sessionRoot, projectId);
      if (!isDir(dir)) continue;
      for (const name of listDir(dir)) {
        if (!name.endsWith('.json')) continue;
        const s = scanSession(storage, path.join(dir, name));
        if (s && s.turns.length) out.push(s);
      }
    }
    return out;
  },
};
