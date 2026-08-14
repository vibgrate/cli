import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  condenseSession,
  newSession,
  recordTask,
  saveSession,
  loadLatestSession,
  loadSession,
  looksLikeSessionId,
  listSessions,
  setLatestSession,
  summarizeSession,
  renameSession,
  deleteSession,
  forkSession,
  rewindSession,
  sanitizeAttachments,
} from './session-store.js';
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

  it('keeps long prompts and answers for History reload (not a 300-char stub)', () => {
    const longInstr = 'find every DriftScore mention\n' + 'x'.repeat(2000);
    const longAnswer =
      '# Top 10 DriftScore mention locations\n\n' +
      'Ranked by importance.\n\n' +
      Array.from({ length: 40 }, (_, i) => `${i + 1}. **packages/foo/bar-${i}.ts** — detail about DriftScore`).join(
        '\n',
      );
    expect(longAnswer.length).toBeGreaterThan(300);
    let s = newSession('long1', 'ollama', 'm', 0);
    s = recordTask(s, { instruction: longInstr, summary: longAnswer, changes: [], stopped: 'finished' }, 1);
    expect(s.tasks[0]!.instruction).toBe(longInstr);
    expect(s.tasks[0]!.summary).toBe(longAnswer);
    // Model recap stays short even when disk holds the full answer.
    const recap = summarizeSession(s);
    expect(recap.length).toBeLessThan(longAnswer.length);
    expect(recap).toContain('find every DriftScore');
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

  it('condenseSession collapses tasks into one checkpoint the recap still covers', () => {
    let s = newSession('s', 'ollama', 'm', 0);
    s = recordTask(s, { instruction: 'do X', summary: 'did X', changes: [change('a.ts')], stopped: 'finished' }, 1);
    s = recordTask(s, { instruction: 'do Y', summary: 'did Y', changes: [change('b.ts')], stopped: 'finished' }, 2);
    const c = condenseSession(s, 3);
    expect(c.tasks).toHaveLength(1);
    expect(c.tasks[0].stopped).toBe('compacted');
    expect(c.tasks[0].files.sort()).toEqual(['a.ts', 'b.ts']);
    const recap = summarizeSession(c);
    expect(recap).toContain('do X');
    expect(recap).toContain('do Y');
    // A single-task (or empty) session has nothing to condense.
    const single = recordTask(newSession('t', 'p', 'm', 0), { instruction: 'only', summary: 's', changes: [], stopped: 'finished' }, 1);
    expect(condenseSession(single, 2)).toBe(single);
  });

  it('returns undefined when there is no session', () => {
    const root = tmp();
    try {
      expect(loadLatestSession(root)).toBeUndefined();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('lists sessions newest-first and can switch latest for multi-chat resume', () => {
    const root = tmp();
    try {
      let a = newSession('a1', 'ollama', 'qwen', 1000);
      a = recordTask(a, { instruction: 'find stripe', summary: 'found it', changes: [], stopped: 'finished' }, 1001);
      saveSession(root, a);
      let b = newSession('b2', 'openrouter', 'claude', 2000);
      b = recordTask(b, { instruction: 'fix timeout', summary: 'fixed', changes: [change('x.ts')], stopped: 'finished' }, 2001);
      saveSession(root, b);

      const list = listSessions(root);
      expect(list.map((e) => e.id)).toEqual(['b2', 'a1']);
      expect(list[0]!.title).toContain('fix timeout');
      expect(list[1]!.taskCount).toBe(1);

      expect(loadLatestSession(root)?.id).toBe('b2');
      expect(setLatestSession(root, 'a1')).toBe(true);
      expect(loadLatestSession(root)?.id).toBe('a1');
      expect(loadSession(root, 'b2')?.model).toBe('claude');
      expect(setLatestSession(root, '../evil')).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('looksLikeSessionId accepts minted ids and rejects instruction words', () => {
    // Minted shape: exactly ten lowercase [a-z0-9] (interactive.ts sessionId()).
    expect(looksLikeSessionId('abc123xyz9')).toBe(true);
    expect(looksLikeSessionId('0123456789')).toBe(true);
    // Everything commander might have eaten off an instruction instead.
    expect(looksLikeSessionId('fix')).toBe(false);
    expect(looksLikeSessionId('fix the tests')).toBe(false);
    expect(looksLikeSessionId('Abc123xyz9')).toBe(false); // uppercase
    expect(looksLikeSessionId('abc123xyz')).toBe(false); // nine chars
    expect(looksLikeSessionId('abc123xyz90')).toBe(false); // eleven chars
    expect(looksLikeSessionId('')).toBe(false);
  });
});

describe('session-store P3 (titles, index, rename/delete/fork/rewind)', () => {
  const seeded = (root: string): void => {
    let a = newSession('aaaaaaaaaa', 'ollama', 'm1', 1000);
    a = recordTask(a, { instruction: 'first chat task', summary: 'done A', changes: [], stopped: 'finished' }, 1001);
    saveSession(root, a);
    let b = newSession('bbbbbbbbbb', 'relay', 'm2', 2000);
    b = recordTask(b, { instruction: 'second chat task', summary: 'done B', changes: [change('x.ts')], stopped: 'finished' }, 2001);
    b = recordTask(b, { instruction: 'follow-up', summary: 'done B2', changes: [], stopped: 'finished' }, 2002);
    saveSession(root, b);
  };

  it('maintains index.json on save and lists from it without parsing sessions', () => {
    const root = tmp();
    try {
      seeded(root);
      const idx = JSON.parse(
        fs.readFileSync(path.join(root, '.vibgrate', 'code-sessions', 'index.json'), 'utf8'),
      ) as { sessions: Array<{ id: string; title: string; taskCount: number }> };
      expect(idx.sessions.map((s) => s.id)).toEqual(['bbbbbbbbbb', 'aaaaaaaaaa']);
      expect(idx.sessions[0].taskCount).toBe(2);
      // Corrupt every session file: the index alone must still serve the list.
      for (const id of ['aaaaaaaaaa', 'bbbbbbbbbb']) {
        fs.writeFileSync(path.join(root, '.vibgrate', 'code-sessions', `${id}.json`), 'not json');
      }
      const listed = listSessions(root);
      expect(listed.map((s) => s.id)).toEqual(['bbbbbbbbbb', 'aaaaaaaaaa']);
      expect(listed[1].title).toBe('first chat task');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rebuilds a missing index from the stored files (and rewrites it)', () => {
    const root = tmp();
    try {
      seeded(root);
      fs.unlinkSync(path.join(root, '.vibgrate', 'code-sessions', 'index.json'));
      const listed = listSessions(root);
      expect(listed.map((s) => s.id)).toEqual(['bbbbbbbbbb', 'aaaaaaaaaa']);
      expect(fs.existsSync(path.join(root, '.vibgrate', 'code-sessions', 'index.json'))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('renameSession sets and clears an explicit title that wins over the derived one', () => {
    const root = tmp();
    try {
      seeded(root);
      expect(renameSession(root, 'aaaaaaaaaa', '  My refactor  ')).toBe(true);
      expect(listSessions(root).find((s) => s.id === 'aaaaaaaaaa')!.title).toBe('My refactor');
      expect(loadSession(root, 'aaaaaaaaaa')!.title).toBe('My refactor');
      // Empty title clears back to the derived first-instruction name.
      expect(renameSession(root, 'aaaaaaaaaa', '')).toBe(true);
      expect(loadSession(root, 'aaaaaaaaaa')!.title).toBeUndefined();
      expect(listSessions(root).find((s) => s.id === 'aaaaaaaaaa')!.title).toBe('first chat task');
      expect(renameSession(root, 'missing000', 'x')).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('title survives recordTask (a rename is not undone by the next turn)', () => {
    const root = tmp();
    try {
      seeded(root);
      renameSession(root, 'bbbbbbbbbb', 'Named chat');
      let s = loadSession(root, 'bbbbbbbbbb')!;
      s = recordTask(s, { instruction: 'more', summary: 'ok', changes: [], stopped: 'finished' }, 3000);
      saveSession(root, s);
      expect(listSessions(root).find((x) => x.id === 'bbbbbbbbbb')!.title).toBe('Named chat');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('deleteSession removes file + index row and clears a latest pointer to it', () => {
    const root = tmp();
    try {
      seeded(root); // latest → bbbbbbbbbb
      expect(deleteSession(root, 'bbbbbbbbbb')).toBe(true);
      expect(loadSession(root, 'bbbbbbbbbb')).toBeUndefined();
      expect(listSessions(root).map((s) => s.id)).toEqual(['aaaaaaaaaa']);
      expect(loadLatestSession(root)).toBeUndefined(); // pointer cleared, no ghost resume
      expect(deleteSession(root, 'bbbbbbbbbb')).toBe(false);
      expect(deleteSession(root, '../escape')).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('forkSession copies under a new id with "(Fork) " title and lineage', () => {
    const root = tmp();
    try {
      seeded(root);
      const fork = forkSession(root, 'bbbbbbbbbb', 'cccccccccc', 5000)!;
      expect(fork.id).toBe('cccccccccc');
      expect(fork.title).toBe('(Fork) second chat task');
      expect(fork.forkedFrom).toBe('bbbbbbbbbb');
      expect(fork.tasks).toHaveLength(2);
      // The original is untouched; both list, fork first (newest updatedAt).
      const listed = listSessions(root);
      expect(listed[0].id).toBe('cccccccccc');
      expect(loadSession(root, 'bbbbbbbbbb')!.title).toBeUndefined();
      expect(forkSession(root, 'missing000', 'dddddddddd', 5001)).toBeUndefined();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rewindSession truncates tasks and refuses non-rewinds', () => {
    const root = tmp();
    try {
      seeded(root);
      const rewound = rewindSession(root, 'bbbbbbbbbb', 1, 6000)!;
      expect(rewound.tasks).toHaveLength(1);
      expect(rewound.tasks[0].instruction).toBe('second chat task');
      expect(rewound.lastChanges).toEqual([]); // /undo of dropped turns is gone
      expect(loadSession(root, 'bbbbbbbbbb')!.tasks).toHaveLength(1);
      expect(listSessions(root).find((s) => s.id === 'bbbbbbbbbb')!.taskCount).toBe(1);
      // keep >= current length or negative is not a rewind.
      expect(rewindSession(root, 'bbbbbbbbbb', 1, 6001)).toBeUndefined();
      expect(rewindSession(root, 'bbbbbbbbbb', -1, 6001)).toBeUndefined();
      // Rewind to zero empties the chat but keeps it resumable.
      expect(rewindSession(root, 'bbbbbbbbbb', 0, 6002)!.tasks).toHaveLength(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('stamps worktree info into the index for the WT badge', () => {
    const root = tmp();
    try {
      let s = newSession('wtwtwtwtwt', 'ollama', 'm', 1000);
      s = { ...s, worktree: { id: 'wtabc123', path: '/tmp/x', base: 'deadbeef' } };
      s = recordTask(s, { instruction: 'isolated work', summary: 'ok', changes: [], stopped: 'finished' }, 1001);
      saveSession(root, s);
      expect(listSessions(root)[0].worktreeId).toBe('wtabc123');
      expect(loadSession(root, 'wtwtwtwtwt')!.worktree!.base).toBe('deadbeef');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('attachment metadata (v5)', () => {
  it('records what was attached, never the bytes', () => {
    const s = newSession('s1', 'p', 'm', 1);
    const next = recordTask(
      s,
      {
        instruction: 'look at this',
        summary: 'done',
        changes: [],
        stopped: 'finished',
        attachments: [
          { name: 'shot.png', kind: 'image', mediaType: 'image/png', bytes: 12345 },
          { name: 'notes.md', kind: 'text' },
        ],
      },
      2,
    );
    expect(next.tasks[0]!.attachments).toEqual([
      { name: 'shot.png', kind: 'image', mediaType: 'image/png', bytes: 12345 },
      { name: 'notes.md', kind: 'text' },
    ]);
    // Nothing resembling a payload made it into the record.
    expect(JSON.stringify(next)).not.toMatch(/dataBase64|data:image/);
  });

  it('omits the field entirely for a turn with no attachments', () => {
    const s = newSession('s1', 'p', 'm', 1);
    const next = recordTask(s, { instruction: 'go', summary: 'ok', changes: [], stopped: 'finished' }, 2);
    expect('attachments' in next.tasks[0]!).toBe(false);
  });

  it('drops malformed entries, caps the list, and trims long names', () => {
    const rows = sanitizeAttachments([
      null,
      'nope',
      { kind: 'image' },
      { name: '   ' },
      { name: 'x'.repeat(300), kind: 'image', bytes: -1, mediaType: 'image/png' },
      ...Array.from({ length: 20 }, (_, i) => ({ name: `f${i}.txt` })),
    ]);
    expect(rows.length).toBeLessThanOrEqual(8);
    expect(rows[0]!.name).toHaveLength(120);
    expect(rows[0]!.bytes).toBeUndefined();
    // An unknown kind defaults to text rather than being invented.
    expect(rows[1]!.kind).toBe('text');
  });
})
