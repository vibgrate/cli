/**
 * Grok CLI sessions: `~/.grok/sessions/<url-encoded cwd>/<session-id>/updates.jsonl`
 * with ACP-style lines `{params:{update:{sessionUpdate:'tool_call'|'tool_call_update', toolCallId, title, rawInput, status, rawOutput, content}}}`.
 */

import * as path from 'node:path';
import { homeDir, isDir, listDir, parseTimestamp, readJsonl } from '../shared.js';
import type { ScanOptions, Scanner, Session } from '../types.js';
import { SessionBuilder } from './common.js';

export function extractGrokOutput(update: Record<string, unknown>): string {
  const raw = update.rawOutput;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const r = raw as Record<string, unknown>;
    for (const key of ['output_for_prompt', 'output', 'FileContent']) {
      const v = r[key];
      if (typeof v === 'string' && v.trim()) return v;
      if (v && typeof v === 'object') {
        const c = (v as Record<string, unknown>).content;
        if (typeof c === 'string' && c.trim()) return c;
      }
    }
  }
  const blocks = update.content;
  if (Array.isArray(blocks)) {
    const parts: string[] = [];
    for (const b of blocks as Array<Record<string, unknown>>) {
      const inner = b?.content as Record<string, unknown> | undefined;
      if (inner && typeof inner.text === 'string') parts.push(inner.text);
    }
    if (parts.length) return parts.join('\n');
  }
  return '';
}

function decodeWorkspace(name: string): string | undefined {
  let decoded = name;
  try {
    decoded = decodeURIComponent(name);
  } catch {
    /* keep raw */
  }
  return path.isAbsolute(decoded) || /^[A-Za-z]:[\\/]/.test(decoded) ? decoded : undefined;
}

function scanUpdates(file: string, sessionId: string, project: string | undefined): Session | null {
  const records = readJsonl(file);
  if (records.length === 0) return null;
  const b = new SessionBuilder('grok', sessionId, file);
  b.project = project;
  for (const rec of records) {
    const ts = parseTimestamp(rec.timestamp ?? rec.ts);
    const params = rec.params as Record<string, unknown> | undefined;
    const update = params?.update as Record<string, unknown> | undefined;
    if (!update || typeof update !== 'object') continue;
    const kind = update.sessionUpdate;
    if (kind === 'tool_call') {
      const id = String(update.toolCallId ?? '');
      const title = typeof update.title === 'string' ? update.title : 'tool';
      const rawInput = update.rawInput && typeof update.rawInput === 'object' && !Array.isArray(update.rawInput) ? update.rawInput : { raw: update.rawInput };
      if (id) b.toolUse(id, title, rawInput, ts);
    } else if (kind === 'tool_call_update') {
      const status = update.status;
      if (status !== 'completed' && status !== 'failed') continue;
      const id = String(update.toolCallId ?? '');
      if (id) b.toolResult(id, extractGrokOutput(update), status === 'failed', ts);
    } else if (kind === 'user_message_chunk' || kind === 'agent_message_chunk') {
      const content = update.content as Record<string, unknown> | undefined;
      const text = content && typeof content.text === 'string' ? content.text : '';
      if (kind === 'user_message_chunk') b.user(text, ts);
      else b.assistant(text, { ts });
    }
  }
  return b.build();
}

export const grokScanner: Scanner = {
  agent: 'grok',
  sessionsDir(env = process.env, home?) {
    return [path.join(homeDir(env, home), '.grok', 'sessions')];
  },
  scan(opts: ScanOptions): Session[] {
    const root = this.sessionsDir(opts.env ?? process.env, opts.home)[0];
    if (!isDir(root)) return [];
    const out: Session[] = [];
    for (const ws of listDir(root)) {
      const wsDir = path.join(root, ws);
      if (!isDir(wsDir)) continue;
      const project = decodeWorkspace(ws);
      for (const sid of listDir(wsDir)) {
        const file = path.join(wsDir, sid, 'updates.jsonl');
        const s = scanUpdates(file, sid, project);
        if (s && s.turns.length) out.push(s);
      }
    }
    return out;
  },
};
