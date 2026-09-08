/**
 * GitHub Copilot CLI sessions: `~/.copilot/session-state/<id>/events.jsonl`
 * (older builds: `~/.copilot/history-session-state/`). Events are
 * `{type, timestamp, data}` with types `session.start`, `user.message`,
 * `assistant.message`, `tool.execution_start`, `tool.execution_complete`.
 * Chat-shaped lines (`role`/`content`) are accepted as a fallback.
 */

import * as path from 'node:path';
import { homeDir, isDir, listDir, parseTimestamp, readJsonl, stringifyOutput } from '../shared.js';
import type { ScanOptions, Scanner, Session } from '../types.js';
import { SessionBuilder, feedChatRecord } from './common.js';

function scanEvents(file: string, sessionId: string): Session | null {
  const records = readJsonl(file);
  if (records.length === 0) return null;
  const b = new SessionBuilder('copilot', sessionId, file);
  for (const rec of records) {
    const type = typeof rec.type === 'string' ? rec.type : '';
    const data = rec.data && typeof rec.data === 'object' ? (rec.data as Record<string, unknown>) : {};
    const ts = parseTimestamp(rec.timestamp ?? data.timestamp);
    switch (type) {
      case 'session.start': {
        const ctx = data.context as Record<string, unknown> | undefined;
        const cwd = data.cwd ?? ctx?.cwd ?? data.workingDirectory;
        if (typeof cwd === 'string' && path.isAbsolute(cwd)) b.project = cwd;
        if (typeof data.sessionId === 'string' && data.sessionId) b.id = data.sessionId;
        b.noteTime(ts);
        break;
      }
      case 'user.message':
        b.user(typeof data.content === 'string' ? data.content : stringifyOutput(data.content), ts);
        break;
      case 'assistant.message': {
        const reqs = Array.isArray(data.toolRequests) ? (data.toolRequests as Array<Record<string, unknown>>) : [];
        for (const r of reqs) if (typeof r?.toolCallId === 'string' && typeof r?.name === 'string') b.toolUse(r.toolCallId, r.name, r.arguments, ts);
        b.assistant(typeof data.content === 'string' ? data.content : '', { ts, hasToolUse: reqs.length > 0 });
        break;
      }
      case 'tool.execution_start': {
        const id = typeof data.toolCallId === 'string' ? data.toolCallId : '';
        const name = typeof data.toolName === 'string' ? data.toolName : typeof data.name === 'string' ? data.name : '';
        if (id && name) b.toolUse(id, name, data.arguments ?? data.input ?? {}, ts);
        break;
      }
      case 'tool.execution_complete': {
        const id = typeof data.toolCallId === 'string' ? data.toolCallId : '';
        if (!id) break;
        const result = data.result;
        const output = data.error !== undefined && data.error !== null ? stringifyOutput(data.error) : stringifyOutput(result);
        b.toolResult(id, output, data.success === false || (data.error !== undefined && data.error !== null), ts);
        break;
      }
      case 'session.interrupted':
      case 'user.interrupt':
        b.user('[Request interrupted by user]', ts);
        break;
      default:
        if (typeof rec.role === 'string' || (rec.message && typeof rec.message === 'object')) feedChatRecord(b, rec);
    }
  }
  return b.build();
}

export const copilotScanner: Scanner = {
  agent: 'copilot',
  sessionsDir(env = process.env, home?) {
    const base = path.join(homeDir(env, home), '.copilot');
    return [path.join(base, 'session-state'), path.join(base, 'history-session-state')];
  },
  scan(opts: ScanOptions): Session[] {
    const out: Session[] = [];
    for (const root of this.sessionsDir(opts.env ?? process.env, opts.home)) {
      if (!isDir(root)) continue;
      for (const sid of listDir(root)) {
        const dir = path.join(root, sid);
        if (!isDir(dir)) continue;
        for (const name of listDir(dir)) {
          if (!name.endsWith('.jsonl')) continue;
          const s = scanEvents(path.join(dir, name), sid);
          if (s && s.turns.length) out.push(s);
        }
      }
    }
    return out;
  },
};
