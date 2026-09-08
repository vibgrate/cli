/**
 * Codex CLI sessions: `~/.codex/sessions/**` — legacy JSON
 * (`{session:{id,timestamp,cwd}, items:[function_call | function_call_output]}`)
 * and modern JSONL rollouts (`{type:'session_meta', payload:{id,cwd}}` then
 * `{type:'response_item', payload:{type:'function_call'|'function_call_output'|…}}`).
 */

import * as path from 'node:path';
import { homeDir, isDir, parseTimestamp, readJson, readJsonl, walkFiles } from '../shared.js';
import type { ScanOptions, Scanner, Session } from '../types.js';
import { SessionBuilder, stem } from './common.js';

function parseArgs(payload: Record<string, unknown>): Record<string, unknown> {
  const raw = payload.arguments ?? payload.input ?? '';
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : { raw };
    } catch {
      return { raw };
    }
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  return { raw: String(raw) };
}

/** `shell` with a list command → Bash with the last element; `exec_command.cmd` → command. */
export function normalizeCodexTool(name: string, args: Record<string, unknown>): { name: string; input: Record<string, unknown> } {
  if (name === 'shell' && 'command' in args) {
    const cmd = args.command;
    return { name: 'Bash', input: { ...args, command: Array.isArray(cmd) ? String(cmd[cmd.length - 1] ?? '') : cmd } };
  }
  if (name === 'exec_command' && 'cmd' in args) return { name: 'Bash', input: { ...args, command: args.cmd } };
  return { name, input: args };
}

/** Output may be a JSON string with `{output, metadata}`. */
export function parseCodexOutput(raw: unknown): string {
  if (typeof raw !== 'string') return raw === undefined || raw === null ? '' : typeof raw === 'object' ? JSON.stringify(raw) : String(raw);
  const t = raw.trim();
  if (!t.startsWith('{')) return raw;
  try {
    const parsed = JSON.parse(t) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const r = parsed as Record<string, unknown>;
      if ('output' in r) return String(r.output);
      return JSON.stringify(r);
    }
  } catch {
    /* plain text */
  }
  return raw;
}

function scanJson(file: string): Session | null {
  const data = readJson(file);
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  const meta = d.session && typeof d.session === 'object' ? (d.session as Record<string, unknown>) : {};
  const items = Array.isArray(d.items) ? (d.items as Record<string, unknown>[]) : [];
  if (items.length === 0) return null;
  const b = new SessionBuilder('codex', typeof meta.id === 'string' && meta.id ? meta.id : stem(file), file);
  b.noteTime(parseTimestamp(meta.timestamp));
  if (typeof meta.cwd === 'string') b.project = meta.cwd;
  feedItems(b, items);
  return b.build();
}

function feedItems(b: SessionBuilder, items: Record<string, unknown>[], tsOf: (item: Record<string, unknown>) => number | undefined = () => undefined): void {
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const type = item.type;
    const ts = tsOf(item);
    if (type === 'function_call' || type === 'custom_tool_call') {
      const callId = typeof item.call_id === 'string' ? item.call_id : '';
      const { name, input } = normalizeCodexTool(typeof item.name === 'string' ? item.name : '', parseArgs(item));
      if (callId && name) b.toolUse(callId, name, input, ts);
    } else if (type === 'function_call_output' || type === 'custom_tool_call_output') {
      const callId = typeof item.call_id === 'string' ? item.call_id : '';
      if (callId) b.toolResult(callId, parseCodexOutput(item.output), false, ts);
    } else if (type === 'message') {
      const role = item.role;
      const content = item.content;
      const text = Array.isArray(content) ? (content as Array<Record<string, unknown>>).map((c) => (typeof c?.text === 'string' ? c.text : '')).join('\n') : typeof content === 'string' ? content : '';
      if (role === 'user') b.user(text, ts);
      else if (role === 'assistant') b.assistant(text, { ts });
    }
  }
}

function scanJsonl(file: string): Session | null {
  const records = readJsonl(file);
  if (records.length === 0) return null;
  const b = new SessionBuilder('codex', stem(file), file);
  const items: Record<string, unknown>[] = [];
  const stamps = new Map<Record<string, unknown>, number | undefined>();
  for (const rec of records) {
    const ts = parseTimestamp(rec.timestamp);
    const payload = rec.payload && typeof rec.payload === 'object' ? (rec.payload as Record<string, unknown>) : null;
    if (rec.type === 'session_meta' && payload) {
      if (typeof payload.id === 'string' && payload.id) b.id = payload.id;
      if (typeof payload.cwd === 'string') b.project = payload.cwd;
      b.noteTime(ts ?? parseTimestamp(payload.timestamp));
      continue;
    }
    if (rec.type === 'response_item' && payload) {
      items.push(payload);
      stamps.set(payload, ts);
    }
  }
  feedItems(b, items, (it) => stamps.get(it));
  return b.build();
}

export const codexScanner: Scanner = {
  agent: 'codex',
  sessionsDir(env = process.env, home?) {
    return [path.join(homeDir(env, home), '.codex', 'sessions')];
  },
  scan(opts: ScanOptions): Session[] {
    const root = this.sessionsDir(opts.env ?? process.env, opts.home)[0];
    if (!isDir(root)) return [];
    const out: Session[] = [];
    for (const file of walkFiles(root, (n) => n.endsWith('.json') || n.endsWith('.jsonl'))) {
      const s = file.endsWith('.jsonl') ? scanJsonl(file) : scanJson(file);
      if (s && s.turns.length) out.push(s);
    }
    return out;
  },
};
