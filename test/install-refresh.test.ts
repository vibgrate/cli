import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  INSTALL_CONTENT_VERSION,
  installedContentVersion,
  skillMarkdown,
  nudgeMarkdown,
  versionMarker,
} from '../src/install/content.js';
import { ASSISTANTS, installAssistant, refreshInstalledInstructions } from '../src/install/registry.js';

const claude = ASSISTANTS.find((a) => a.id === 'claude')!;
const cursor = ASSISTANTS.find((a) => a.id === 'cursor')!;
const launch = { command: 'vg', args: ['serve'] };

describe('version marker', () => {
  it('is embedded in every generated template and parses back', () => {
    expect(installedContentVersion(skillMarkdown('claude'))).toBe(INSTALL_CONTENT_VERSION);
    expect(installedContentVersion(nudgeMarkdown(false, 'claude'))).toBe(INSTALL_CONTENT_VERSION);
    expect(installedContentVersion(nudgeMarkdown(true, 'claude'))).toBe(INSTALL_CONTENT_VERSION);
    expect(installedContentVersion('no marker here')).toBeNull();
  });

  it('strongly recommends MCP over the CLI', () => {
    const skill = skillMarkdown('claude');
    expect(skill).toContain('Use the MCP tools — not the CLI');
    expect(skill).toContain('only when the MCP server is unavailable');
    expect(nudgeMarkdown(false, 'claude')).toContain('always use its tools');
  });
});

describe('refreshInstalledInstructions', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-refresh-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('is a no-op when everything is current or nothing is installed', () => {
    expect(refreshInstalledInstructions(root, false)).toEqual([]);
    installAssistant(claude, { root, smallRepo: false, launch });
    expect(refreshInstalledInstructions(root, false)).toEqual([]);
  });

  it('rewrites files whose marker is older than the current version', () => {
    installAssistant(claude, { root, smallRepo: false, launch });
    const skillFile = path.join(root, claude.skill!);
    // Simulate a copy written by an older CLI: same shape, older version.
    fs.writeFileSync(skillFile, fs.readFileSync(skillFile, 'utf8').replace(/vg:v\d+/, 'vg:v1'));

    const refreshed = refreshInstalledInstructions(root, false);
    expect(refreshed).toEqual(
      expect.arrayContaining([expect.objectContaining({ file: claude.skill, from: 1, to: INSTALL_CONTENT_VERSION })]),
    );
    expect(installedContentVersion(fs.readFileSync(skillFile, 'utf8'))).toBe(INSTALL_CONTENT_VERSION);
  });

  it('recognises legacy pre-versioning generated content as version 0', () => {
    const skillFile = path.join(root, claude.skill!);
    fs.mkdirSync(path.dirname(skillFile), { recursive: true });
    fs.writeFileSync(skillFile, '---\nname: vg\n---\n\n# vg — the code map\n\nold generated copy\n');

    const refreshed = refreshInstalledInstructions(root, false);
    expect(refreshed).toEqual(
      expect.arrayContaining([expect.objectContaining({ file: claude.skill, from: 0 })]),
    );
    expect(fs.readFileSync(skillFile, 'utf8')).toContain('Use the MCP tools — not the CLI');
  });

  it('never touches user-authored files without marker or generated shape', () => {
    const skillFile = path.join(root, claude.skill!);
    fs.mkdirSync(path.dirname(skillFile), { recursive: true });
    const custom = '---\nname: vg\n---\n\n# My own custom vg notes\n';
    fs.writeFileSync(skillFile, custom);
    expect(refreshInstalledInstructions(root, false)).toEqual([]);
    expect(fs.readFileSync(skillFile, 'utf8')).toBe(custom);
  });

  it('removing the marker line opts a file out of refreshes', () => {
    installAssistant(claude, { root, smallRepo: false, launch });
    const skillFile = path.join(root, claude.skill!);
    const edited = fs
      .readFileSync(skillFile, 'utf8')
      .split('\n')
      .filter((l) => !l.includes('vg:v'))
      .join('\n')
      // Also drop the generated heading so the legacy heuristic can't claim it.
      .replace('# vg — the code map', '# vg — my tuned copy');
    fs.writeFileSync(skillFile, edited);
    expect(refreshInstalledInstructions(root, false)).toEqual([]);
    expect(fs.readFileSync(skillFile, 'utf8')).toBe(edited);
  });

  it('refreshes only the vg block inside a nudge host file, preserving the rest', () => {
    installAssistant(claude, { root, smallRepo: false, launch });
    const nudgeFile = path.join(root, claude.nudge!.file);
    const userContent = '# My project\n\nHand-written instructions stay.\n\n';
    fs.writeFileSync(nudgeFile, userContent + fs.readFileSync(nudgeFile, 'utf8').replace(/vg:v\d+/, 'vg:v1'));

    const refreshed = refreshInstalledInstructions(root, false);
    expect(refreshed).toEqual(
      expect.arrayContaining([expect.objectContaining({ file: claude.nudge!.file, from: 1 })]),
    );
    const after = fs.readFileSync(nudgeFile, 'utf8');
    expect(after).toContain('Hand-written instructions stay.');
    expect(after).toContain(versionMarker());
  });

  it('refreshes stale file-kind nudges (.mdc) too', () => {
    installAssistant(cursor, { root, smallRepo: false, launch });
    const mdc = path.join(root, cursor.nudge!.file);
    fs.writeFileSync(mdc, fs.readFileSync(mdc, 'utf8').replace(/vg:v\d+/, 'vg:v1'));
    const refreshed = refreshInstalledInstructions(root, false);
    expect(refreshed).toEqual(
      expect.arrayContaining([expect.objectContaining({ file: cursor.nudge!.file, from: 1 })]),
    );
    expect(installedContentVersion(fs.readFileSync(mdc, 'utf8'))).toBe(INSTALL_CONTENT_VERSION);
  });

  it('the reference skill copy in-repo matches the generated template version', () => {
    const reference = fs.readFileSync(path.join(__dirname, '..', 'skills', 'vg', 'SKILL.md'), 'utf8');
    expect(installedContentVersion(reference)).toBe(INSTALL_CONTENT_VERSION);
  });
});
