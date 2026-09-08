/**
 * Test helper: materialise the fixture transcripts into a fake HOME laid out
 * exactly as each agent writes it. Returns the paths tests need.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES = path.dirname(fileURLToPath(import.meta.url));

export interface InstalledFixtures {
  home: string;
  project: string;
  env: NodeJS.ProcessEnv;
}

function copy(src: string, dest: string): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function copyTree(src: string, dest: string): void {
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyTree(s, d);
    else copy(s, d);
  }
}

/** Fixture transcripts all record `/home/user/demo` as their project. */
export const FIXTURE_PROJECT = '/home/user/demo';

export function installFixtures(opts: { agents?: string[]; project?: string } = {}): InstalledFixtures {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-learn-home-'));
  const project = opts.project ?? path.join(home, 'demo');
  fs.mkdirSync(project, { recursive: true });
  const want = new Set(opts.agents ?? ['claude', 'codex', 'gemini', 'grok', 'opencode', 'cursor', 'copilot', 'aider']);

  if (want.has('claude')) {
    const projectDir = path.join(home, '.claude', 'projects', '-home-user-demo');
    copy(path.join(FIXTURES, 'claude', 'main-session.jsonl'), path.join(projectDir, 'main-session.jsonl'));
    copy(path.join(FIXTURES, 'claude', 'subagent.jsonl'), path.join(projectDir, 'main-session', 'subagents', 'agent-1.jsonl'));
  }
  if (want.has('codex')) {
    copy(path.join(FIXTURES, 'codex', 'legacy-session.json'), path.join(home, '.codex', 'sessions', 'legacy-session.json'));
    copy(path.join(FIXTURES, 'codex', 'rollout-2026-09-01.jsonl'), path.join(home, '.codex', 'sessions', '2026', '09', '01', 'rollout-2026-09-01.jsonl'));
  }
  if (want.has('gemini')) copy(path.join(FIXTURES, 'gemini', 'session-2026-09-01.json'), path.join(home, '.gemini', 'tmp', 'a1b2c3', 'chats', 'session-2026-09-01.json'));
  if (want.has('grok')) copy(path.join(FIXTURES, 'grok', 'updates.jsonl'), path.join(home, '.grok', 'sessions', encodeURIComponent(FIXTURE_PROJECT), 'grok-1', 'updates.jsonl'));
  if (want.has('opencode')) copyTree(path.join(FIXTURES, 'opencode', 'storage'), path.join(home, '.local', 'share', 'opencode', 'storage'));
  if (want.has('cursor')) copy(path.join(FIXTURES, 'cursor', 'transcript.jsonl'), path.join(home, '.cursor', 'projects', 'home-user-demo', 'agent-transcripts', 'cur-1', 'cur-1.jsonl'));
  if (want.has('copilot')) copy(path.join(FIXTURES, 'copilot', 'events.jsonl'), path.join(home, '.copilot', 'session-state', 'copilot-1', 'events.jsonl'));
  if (want.has('aider')) copy(path.join(FIXTURES, 'aider', '.aider.chat.history.md'), path.join(project, '.aider.chat.history.md'));

  const env: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home, XDG_DATA_HOME: path.join(home, '.local', 'share') };
  return { home, project, env };
}

export function removeFixtures(installed: InstalledFixtures): void {
  fs.rmSync(installed.home, { recursive: true, force: true });
}
