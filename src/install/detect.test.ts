import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectAssistants } from './registry.js';

const none = () => null;

let root: string;
let home: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-detect-root-'));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-detect-home-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

describe('detectAssistants', () => {
  it('detects nothing in an empty repo with an empty home and no binaries', () => {
    expect(detectAssistants(root, { home, which: none })).toEqual([]);
  });

  it('detects an assistant by its repo footprint', () => {
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# hi');
    const found = detectAssistants(root, { home, which: none });
    expect(found.map((d) => d.assistant.id)).toEqual(['claude']);
    expect(found[0]).toMatchObject({ via: 'repo', marker: 'CLAUDE.md' });
  });

  it('detects by directory markers too', () => {
    fs.mkdirSync(path.join(root, '.cursor'));
    const found = detectAssistants(root, { home, which: none });
    expect(found.map((d) => d.assistant.id)).toEqual(['cursor']);
  });

  it('falls back to home-folder config when the repo carries no sign', () => {
    fs.mkdirSync(path.join(home, '.codex'));
    const found = detectAssistants(root, { home, which: none });
    expect(found.map((d) => d.assistant.id)).toEqual(['codex']);
    expect(found[0]).toMatchObject({ via: 'home', marker: '.codex' });
  });

  it('falls back to a CLI on PATH last', () => {
    const found = detectAssistants(root, {
      home,
      which: (cmd) => (cmd === 'gemini' ? '/usr/local/bin/gemini' : null),
    });
    expect(found.map((d) => d.assistant.id)).toEqual(['gemini']);
    expect(found[0]).toMatchObject({ via: 'path', marker: 'gemini' });
  });

  it('prefers the most local evidence and reports each assistant once', () => {
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# hi');
    fs.mkdirSync(path.join(home, '.claude'));
    const found = detectAssistants(root, {
      home,
      which: (cmd) => (cmd === 'claude' ? '/usr/local/bin/claude' : null),
    });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ via: 'repo', marker: 'CLAUDE.md' });
  });

  it('detects several assistants side by side (AGENTS.md counts as the generic footprint)', () => {
    fs.writeFileSync(path.join(root, 'AGENTS.md'), '# agents');
    fs.mkdirSync(path.join(root, '.windsurf'));
    const ids = detectAssistants(root, { home, which: none }).map((d) => d.assistant.id);
    expect(ids).toContain('agents');
    expect(ids).toContain('windsurf');
  });
});
