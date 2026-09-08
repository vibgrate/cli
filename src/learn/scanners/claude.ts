/**
 * Claude Code transcripts: `$CLAUDE_CONFIG_DIR|~/.claude/projects/<escaped-path>/*.jsonl`,
 * with subagents under `<project>/<uuid>/subagents/**` and workflows under
 * `.../subagents/workflows/**`. Each line is `{type, message, timestamp, cwd, …}`.
 */

import * as path from 'node:path';
import { homeDir, isDir, listDir, readJsonl, walkFiles } from '../shared.js';
import type { ScanOptions, Scanner, Session, SessionSource } from '../types.js';
import { sessionFromChatRecords, stem } from './common.js';

export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env, home?: string): string {
  const base = env.CLAUDE_CONFIG_DIR?.trim();
  return base ? path.resolve(base) : path.join(homeDir(env, home), '.claude');
}

/** `-home-user-repo` → `/home/user/repo`; `C--Users-x` → `C:\Users\x` (best effort, no fs probing). */
export function decodeClaudeProjectDir(name: string): string | undefined {
  const win = /^-?([A-Za-z])--?(.+)$/.exec(name);
  if (win) {
    const tokens = win[2].split('-').filter(Boolean);
    return `${win[1].toUpperCase()}:\\${tokens.join('\\')}`;
  }
  if (!name.startsWith('-')) return undefined;
  return '/' + name.slice(1).replace(/-/g, '/');
}

function classifySource(projectDir: string, file: string): SessionSource {
  const parts = path.relative(projectDir, file).split(path.sep);
  if (parts.length === 1) return 'main';
  if (parts.includes('workflows')) return 'workflow';
  return 'subagent';
}

export const claudeScanner: Scanner = {
  agent: 'claude',
  sessionsDir(env = process.env, home?) {
    return [path.join(claudeConfigDir(env, home), 'projects')];
  },
  scan(opts: ScanOptions): Session[] {
    const root = this.sessionsDir(opts.env ?? process.env, opts.home)[0];
    if (!isDir(root)) return [];
    const out: Session[] = [];
    for (const entry of listDir(root)) {
      if (entry.startsWith('.')) continue;
      const projectDir = path.join(root, entry);
      if (!isDir(projectDir)) continue;
      const decoded = decodeClaudeProjectDir(entry);
      for (const file of walkFiles(projectDir, (n) => n.endsWith('.jsonl'))) {
        const records = readJsonl(file);
        if (records.length === 0) continue;
        const session = sessionFromChatRecords('claude', stem(file), file, records, classifySource(projectDir, file));
        if (!session.project && decoded) session.project = decoded;
        if (session.turns.length === 0) continue;
        out.push(session);
      }
    }
    return out;
  },
};
