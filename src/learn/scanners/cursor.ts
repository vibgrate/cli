/**
 * Cursor agent transcripts: `~/.cursor/projects/<slug>/agent-transcripts/**\/*.jsonl`
 * (and `~/.cursor/chats/**\/*.jsonl`). Lines are chat-shaped — either
 * `{role, content, tool_calls}` or `{type, message}` — so the generic parser
 * applies. The project comes from a `cwd`/`workspace` field when present,
 * else from the slug (`home-user-repo` → `/home/user/repo`, when it exists).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { homeDir, isDir, listDir, readJsonl, walkFiles } from '../shared.js';
import type { ScanOptions, Scanner, Session } from '../types.js';
import { sessionFromChatRecords, stem } from './common.js';

/** Best-effort slug → path (only when the decoded path exists). */
export function decodeCursorSlug(slug: string, exists: (p: string) => boolean = (p) => fs.existsSync(p)): string | undefined {
  const win = /^([A-Za-z])-(.+)$/.exec(slug);
  const candidates: string[] = ['/' + slug.replace(/-/g, '/')];
  if (win) candidates.push(`${win[1].toUpperCase()}:\\${win[2].replace(/-/g, '\\')}`);
  for (const c of candidates) if (exists(c)) return c;
  return undefined;
}

export const cursorScanner: Scanner = {
  agent: 'cursor',
  sessionsDir(env = process.env, home?) {
    const base = path.join(homeDir(env, home), '.cursor');
    return [path.join(base, 'projects'), path.join(base, 'chats')];
  },
  scan(opts: ScanOptions): Session[] {
    const [projects, chats] = this.sessionsDir(opts.env ?? process.env, opts.home);
    const out: Session[] = [];
    if (isDir(projects)) {
      for (const slug of listDir(projects)) {
        const dir = path.join(projects, slug);
        if (!isDir(dir)) continue;
        const decoded = decodeCursorSlug(slug);
        for (const file of walkFiles(dir, (n) => n.endsWith('.jsonl'))) {
          const records = readJsonl(file);
          if (records.length === 0) continue;
          const s = sessionFromChatRecords('cursor', stem(file), file, records);
          if (!s.project && decoded) s.project = decoded;
          if (s.turns.length) out.push(s);
        }
      }
    }
    if (isDir(chats)) {
      for (const file of walkFiles(chats, (n) => n.endsWith('.jsonl'))) {
        const records = readJsonl(file);
        if (records.length === 0) continue;
        const s = sessionFromChatRecords('cursor', stem(file), file, records);
        if (s.turns.length) out.push(s);
      }
    }
    return out;
  },
};
