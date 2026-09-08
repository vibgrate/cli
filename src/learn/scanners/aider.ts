/**
 * Aider chat history: `<project>/.aider.chat.history.md` (override with
 * `AIDER_CHAT_HISTORY_FILE`). Markdown, one file per project, sessions split
 * on `# aider chat started at YYYY-MM-DD HH:MM:SS`:
 *
 *   #### user prompt                      → user turn
 *   #### /run pytest                      → Bash call; `> ` lines that follow are its output
 *   > Applied edit to src/foo.py          → Edit call (ok)
 *   plain prose                           → assistant turn
 */

import * as path from 'node:path';
import { homeDir, isFile, parseTimestamp, readTextTolerant } from '../shared.js';
import type { ScanOptions, Scanner, Session } from '../types.js';
import { SessionBuilder } from './common.js';

const SESSION_RE = /^# aider chat started at (.+)$/;
const APPLIED_RE = /^> Applied edit to (.+)$/;
const RUN_CMDS = new Set(['/run', '/test', '/lint', '/git']);

export function aiderHistoryFiles(env: NodeJS.ProcessEnv, home: string | undefined, project: string | undefined): string[] {
  const override = env.AIDER_CHAT_HISTORY_FILE?.trim();
  const files: string[] = [];
  if (override) files.push(path.resolve(override));
  const root = project ?? process.cwd();
  files.push(path.join(root, '.aider.chat.history.md'));
  files.push(path.join(homeDir(env, home), '.aider.chat.history.md'));
  return [...new Set(files)];
}

/** Parse one history file into sessions (deterministic ids: `<stem>-<n>`). */
export function parseAiderHistory(file: string, project: string | undefined): Session[] {
  const text = readTextTolerant(file);
  if (!text.trim()) return [];
  const out: Session[] = [];
  let b: SessionBuilder | null = null;
  let n = 0;
  let seq = 0;
  let pendingRun: { cmd: string; output: string[]; ts?: number } | null = null;
  let userBuf: string[] = [];
  let asstBuf: string[] = [];
  let lastTs: number | undefined;

  const flushUser = (): void => {
    if (b && userBuf.length) b.user(userBuf.join('\n'), lastTs);
    userBuf = [];
  };
  const flushAsst = (): void => {
    if (b && asstBuf.length) b.assistant(asstBuf.join('\n'), { ts: lastTs });
    asstBuf = [];
  };
  const flushRun = (): void => {
    if (b && pendingRun) b.toolCall(`aider_${b.id}_${++seq}`, 'Bash', { command: pendingRun.cmd }, pendingRun.output.join('\n'), false, pendingRun.ts);
    pendingRun = null;
  };
  const finish = (): void => {
    flushUser();
    flushAsst();
    flushRun();
    if (b && b.turns.length) out.push(b.build());
    b = null;
  };

  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    const start = SESSION_RE.exec(line);
    if (start) {
      finish();
      n += 1;
      b = new SessionBuilder('aider', `${path.basename(file).replace(/\.md$/, '')}-${n}`, file);
      b.project = project;
      lastTs = parseTimestamp(start[1].trim().replace(' ', 'T'));
      b.noteTime(lastTs);
      continue;
    }
    if (!line.trim()) {
      flushUser();
      continue;
    }
    if (!b) {
      n += 1;
      b = new SessionBuilder('aider', `${path.basename(file).replace(/\.md$/, '')}-${n}`, file);
      b.project = project;
    }
    if (line.startsWith('#### ')) {
      flushAsst();
      flushRun();
      const body = line.slice(5).trim();
      const cmdWord = body.split(/\s+/)[0] ?? '';
      if (RUN_CMDS.has(cmdWord)) {
        flushUser();
        pendingRun = { cmd: body.slice(cmdWord.length).trim() || cmdWord, output: [], ts: lastTs };
      } else userBuf.push(body);
      continue;
    }
    if (line.startsWith('> ')) {
      flushUser();
      flushAsst();
      const applied = APPLIED_RE.exec(line);
      if (applied) {
        flushRun();
        b.toolCall(`aider_${b.id}_${++seq}`, 'Edit', { file_path: applied[1].trim() }, 'Applied edit', false, lastTs);
        continue;
      }
      if (pendingRun) pendingRun.output.push(line.slice(2));
      continue;
    }
    flushUser();
    if (pendingRun) flushRun();
    asstBuf.push(line);
  }
  finish();
  return out;
}

export const aiderScanner: Scanner = {
  agent: 'aider',
  sessionsDir(env = process.env, home?) {
    return aiderHistoryFiles(env, home, undefined).map((f) => path.dirname(f));
  },
  scan(opts: ScanOptions): Session[] {
    const env = opts.env ?? process.env;
    const out: Session[] = [];
    for (const file of aiderHistoryFiles(env, opts.home, opts.project)) {
      if (!isFile(file)) continue;
      out.push(...parseAiderHistory(file, opts.project ?? path.dirname(file)));
    }
    return out;
  },
};
