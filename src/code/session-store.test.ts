import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { newSession, recordTask, saveSession, loadLatestSession, summarizeSession } from './session-store.js';
import type { FileChange } from './types.js';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vg-sess-'));
}
const change = (file: string): FileChange => ({ file, before: 'a', after: 'b', outcomes: [{ edit: { op: 'replace', file, search: 'a', replace: 'b' }, status: 'applied' }], diff: 'd' });

describe('session-store', () => {
  it('records tasks and round-trips through save/load', () => {
    const root = tmp();
    try {
      let s = newSession('sess1', 'ollama', 'qwen2.5-coder:7b', 1000);
      s = recordTask(s, { instruction: 'add a flag', summary: 'added --timeout', changes: [change('src/scan.ts')], stopped: 'finished' }, 1001);
      saveSession(root, s);

      const loaded = loadLatestSession(root)!;
      expect(loaded.id).toBe('sess1');
      expect(loaded.tasks).toHaveLength(1);
      expect(loaded.tasks[0].files).toEqual(['src/scan.ts']);
      expect(loaded.lastChanges).toHaveLength(1); // /undo survives a restart
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('summarizes a session for continuation', () => {
    let s = newSession('s', 'openrouter', 'anthropic/claude-3.5-sonnet', 0);
    s = recordTask(s, { instruction: 'do X', summary: 'did X', changes: [change('a.ts')], stopped: 'finished' }, 1);
    s = recordTask(s, { instruction: 'do Y', summary: 'did Y', changes: [], stopped: 'finished' }, 2);
    const recap = summarizeSession(s);
    expect(recap).toContain('do X');
    expect(recap).toContain('do Y');
    expect(recap).toContain('a.ts');
  });

  it('returns undefined when there is no session', () => {
    const root = tmp();
    try {
      expect(loadLatestSession(root)).toBeUndefined();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
