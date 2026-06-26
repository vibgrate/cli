import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { assistantById, installAssistant, uninstallAssistant } from '../src/install/registry.js';
import { makeProject, cleanup } from './helpers.js';

const dirs: string[] = [];
function project(): string {
  const d = makeProject({ 'a.ts': 'export function a(){}' });
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) cleanup(dirs.pop()!);
});

describe('vg install registry', () => {
  it('writes MCP, skill, and nudge for Claude Code', () => {
    const root = project();
    const claude = assistantById('claude')!;
    installAssistant(claude, { root, smallRepo: false });
    const mcp = JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8'));
    expect(mcp.mcpServers.vg.command).toBe('vg');
    expect(fs.existsSync(path.join(root, '.claude/skills/vg/SKILL.md'))).toBe(true);
    expect(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8')).toContain('vg:begin');
  });

  it('is idempotent (no duplicate MCP entries or nudge blocks)', () => {
    const root = project();
    const claude = assistantById('claude')!;
    installAssistant(claude, { root, smallRepo: false });
    installAssistant(claude, { root, smallRepo: false });
    const claudeMd = fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8');
    expect(claudeMd.match(/vg:begin/g)?.length).toBe(1);
    const mcp = JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8'));
    expect(Object.keys(mcp.mcpServers)).toEqual(['vg']);
  });

  it('preserves other MCP servers when merging', () => {
    const root = project();
    fs.writeFileSync(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
    installAssistant(assistantById('claude')!, { root, smallRepo: false });
    const mcp = JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8'));
    expect(mcp.mcpServers.other).toBeDefined();
    expect(mcp.mcpServers.vg).toBeDefined();
  });

  it('--no-hook skips the nudge', () => {
    const root = project();
    installAssistant(assistantById('claude')!, { root, smallRepo: false, hook: false });
    expect(fs.existsSync(path.join(root, 'CLAUDE.md'))).toBe(false);
  });

  it('uninstall removes the MCP entry and nudge, keeps the file otherwise', () => {
    const root = project();
    fs.writeFileSync(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
    const claude = assistantById('claude')!;
    installAssistant(claude, { root, smallRepo: false });
    uninstallAssistant(claude, root, false);
    const mcp = JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8'));
    expect(mcp.mcpServers.vg).toBeUndefined();
    expect(mcp.mcpServers.other).toBeDefined();
    expect(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8')).not.toContain('vg:begin');
  });

  it('writes the small-repo nudge variant', () => {
    const root = project();
    installAssistant(assistantById('cursor')!, { root, smallRepo: true });
    const mdc = fs.readFileSync(path.join(root, '.cursor/rules/vg.mdc'), 'utf8');
    expect(mdc).toContain('alwaysApply: true');
    expect(mdc).toContain('small enough');
  });
});
