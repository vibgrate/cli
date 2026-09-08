/**
 * Gemini CLI sessions: `~/.gemini/tmp/<project-hash>/chats/session-*.json(l)`.
 * Messages are Gemini API shaped (`role` + `parts[]` with `functionCall` /
 * `functionResponse`), or the newer checkpoint shape (`type:'user'|'gemini'`,
 * `content`, `toolCalls[{id,name,args,result,status}]`).
 */

import * as path from 'node:path';
import { homeDir, isDir, listDir, parseTimestamp, readJson, readJsonl, stringifyOutput } from '../shared.js';
import type { ScanOptions, Scanner, Session } from '../types.js';
import { SessionBuilder, stem } from './common.js';

function projectFromEntry(entry: Record<string, unknown>): string | undefined {
  for (const key of ['projectPath', 'project_path', 'cwd', 'workingDirectory', 'directory']) {
    const v = entry[key];
    if (typeof v === 'string' && v && path.isAbsolute(v)) return v;
  }
  return undefined;
}

function feedMessages(b: SessionBuilder, messages: unknown[]): void {
  const pendingByName = new Map<string, { name: string; args: unknown; ts?: number }>();
  let seq = 0;
  for (const raw of messages) {
    if (!raw || typeof raw !== 'object') continue;
    const msg = raw as Record<string, unknown>;
    const ts = parseTimestamp(msg.timestamp);
    const role = typeof msg.role === 'string' ? msg.role : msg.type === 'gemini' ? 'model' : typeof msg.type === 'string' ? msg.type : '';
    const usage = (msg.usageMetadata ?? msg.usage ?? msg.tokens) as Record<string, unknown> | undefined;
    const inTok = usage && typeof usage.promptTokenCount === 'number' ? usage.promptTokenCount : usage && typeof usage.input === 'number' ? usage.input : 0;
    const outTok = usage && typeof usage.candidatesTokenCount === 'number' ? usage.candidatesTokenCount : usage && typeof usage.output === 'number' ? usage.output : 0;
    if (!b.project) b.project = projectFromEntry(msg);

    const parts = Array.isArray(msg.parts) ? (msg.parts as Array<Record<string, unknown>>) : [];
    const texts: string[] = [];
    let hasToolUse = false;
    for (const part of parts) {
      if (!part || typeof part !== 'object') continue;
      if (typeof part.text === 'string') texts.push(part.text);
      const fc = part.functionCall as Record<string, unknown> | undefined;
      if (fc && typeof fc.name === 'string') {
        hasToolUse = true;
        pendingByName.set(fc.name, { name: fc.name, args: fc.args, ts });
      }
      const fr = part.functionResponse as Record<string, unknown> | undefined;
      if (fr && typeof fr.name === 'string') {
        const pend = pendingByName.get(fr.name);
        pendingByName.delete(fr.name);
        const resp = fr.response;
        const output = resp && typeof resp === 'object' && !Array.isArray(resp) ? stringifyOutput(resp) : stringifyOutput(resp);
        b.toolCall(`${b.id}_${++seq}_${fr.name}`, pend?.name ?? fr.name, pend?.args ?? {}, output, false, ts);
      }
    }
    if (typeof msg.content === 'string') texts.push(msg.content);
    const toolCalls = Array.isArray(msg.toolCalls) ? (msg.toolCalls as Array<Record<string, unknown>>) : [];
    for (const tc of toolCalls) {
      if (!tc || typeof tc.name !== 'string') continue;
      hasToolUse = true;
      const status = typeof tc.status === 'string' ? tc.status.toLowerCase() : '';
      const id = typeof tc.id === 'string' && tc.id ? tc.id : `${b.id}_${++seq}_${tc.name}`;
      b.toolCall(id, tc.name, tc.args ?? {}, stringifyOutput(tc.result ?? tc.output), status === 'error' || status === 'failed', ts);
    }
    const text = texts.join('\n');
    if (role === 'user') b.user(text, ts);
    else if (role === 'model' || role === 'assistant') b.assistant(text, { ts, inputTokens: inTok, outputTokens: outTok, hasToolUse });
  }
}

function scanJson(file: string): Session | null {
  const data = readJson(file);
  if (!data) return null;
  let messages: unknown[] = [];
  let id = stem(file);
  const b = new SessionBuilder('gemini', id, file);
  if (Array.isArray(data)) messages = data;
  else if (typeof data === 'object') {
    const d = data as Record<string, unknown>;
    const m = d.messages ?? d.history ?? d.contents;
    messages = Array.isArray(m) ? m : [];
    const sid = d.sessionId ?? d.id ?? d.session_id;
    if (typeof sid === 'string' && sid) id = sid;
    b.id = id;
    b.project = projectFromEntry(d);
    b.noteTime(parseTimestamp(d.startTime));
    b.noteTime(parseTimestamp(d.lastUpdated));
  }
  feedMessages(b, messages);
  return b.build();
}

function scanJsonl(file: string): Session | null {
  const records = readJsonl(file);
  if (records.length === 0) return null;
  const b = new SessionBuilder('gemini', stem(file), file);
  const messages: Record<string, unknown>[] = [];
  for (const rec of records) {
    if (rec.type === 'session_metadata') {
      const sid = rec.id ?? rec.session_id ?? rec.sessionId;
      if (typeof sid === 'string' && sid) b.id = sid;
      if (!b.project) b.project = projectFromEntry(rec);
      continue;
    }
    if (!b.project) b.project = projectFromEntry(rec);
    messages.push(rec);
  }
  feedMessages(b, messages);
  return b.build();
}

export const geminiScanner: Scanner = {
  agent: 'gemini',
  sessionsDir(env = process.env, home?) {
    return [path.join(homeDir(env, home), '.gemini', 'tmp')];
  },
  scan(opts: ScanOptions): Session[] {
    const root = this.sessionsDir(opts.env ?? process.env, opts.home)[0];
    if (!isDir(root)) return [];
    const out: Session[] = [];
    for (const projectDir of listDir(root)) {
      const chats = path.join(root, projectDir, 'chats');
      if (!isDir(chats)) continue;
      for (const name of listDir(chats)) {
        if (!name.startsWith('session-') || !(name.endsWith('.json') || name.endsWith('.jsonl'))) continue;
        const file = path.join(chats, name);
        const s = name.endsWith('.jsonl') ? scanJsonl(file) : scanJson(file);
        if (s && s.turns.length) out.push(s);
      }
    }
    return out;
  },
};
