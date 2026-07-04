import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { assistantById, detectServeLaunch, installAssistant, uninstallAssistant, writeNavigationConfig } from '../src/install/registry.js';
import { HOT_TOOLS, deferredToolNames, navigationToolsetConfig, TOOLS } from '../src/mcp/tools.js';
import { CliError } from '../src/util/exit.js';
import { makeProject, cleanup } from './helpers.js';

/** Tests pin the launch so results don't depend on the machine's PATH. */
const VG_LAUNCH = { command: 'vg', args: ['serve'] };

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
    installAssistant(claude, { root, smallRepo: false, launch: VG_LAUNCH });
    const mcp = JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8'));
    expect(mcp.mcpServers.vg.command).toBe('vg');
    expect(fs.existsSync(path.join(root, '.claude/skills/vg/SKILL.md'))).toBe(true);
    expect(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8')).toContain('vg:begin');
  });

  it('is idempotent (no duplicate MCP entries or nudge blocks)', () => {
    const root = project();
    const claude = assistantById('claude')!;
    installAssistant(claude, { root, smallRepo: false, launch: VG_LAUNCH });
    installAssistant(claude, { root, smallRepo: false, launch: VG_LAUNCH });
    const claudeMd = fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8');
    expect(claudeMd.match(/vg:begin/g)?.length).toBe(1);
    const mcp = JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8'));
    expect(Object.keys(mcp.mcpServers)).toEqual(['vg']);
  });

  it('preserves other MCP servers when merging', () => {
    const root = project();
    fs.writeFileSync(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
    installAssistant(assistantById('claude')!, { root, smallRepo: false, launch: VG_LAUNCH });
    const mcp = JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8'));
    expect(mcp.mcpServers.other).toBeDefined();
    expect(mcp.mcpServers.vg).toBeDefined();
  });

  it('--no-hook skips the nudge', () => {
    const root = project();
    installAssistant(assistantById('claude')!, { root, smallRepo: false, hook: false, launch: VG_LAUNCH });
    expect(fs.existsSync(path.join(root, 'CLAUDE.md'))).toBe(false);
  });

  it('uninstall removes the MCP entry and nudge, keeps the file otherwise', () => {
    const root = project();
    fs.writeFileSync(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
    const claude = assistantById('claude')!;
    installAssistant(claude, { root, smallRepo: false, launch: VG_LAUNCH });
    uninstallAssistant(claude, root, false);
    const mcp = JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8'));
    expect(mcp.mcpServers.vg).toBeUndefined();
    expect(mcp.mcpServers.other).toBeDefined();
    expect(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8')).not.toContain('vg:begin');
  });

  it('writes the small-repo nudge variant', () => {
    const root = project();
    installAssistant(assistantById('cursor')!, { root, smallRepo: true, launch: VG_LAUNCH });
    const mdc = fs.readFileSync(path.join(root, '.cursor/rules/vg.mdc'), 'utf8');
    expect(mdc).toContain('alwaysApply: true');
    expect(mdc).toContain('small enough');
  });
});

describe('vg install safety', () => {
  it('refuses to overwrite a malformed .mcp.json (no data loss)', () => {
    const root = project();
    const file = path.join(root, '.mcp.json');
    const malformed = '{ "mcpServers": { "other": { "command": "x" }, }';
    fs.writeFileSync(file, malformed);
    expect(() => installAssistant(assistantById('claude')!, { root, smallRepo: false, launch: VG_LAUNCH })).toThrow(CliError);
    // The malformed file is untouched — the user's entries are recoverable.
    expect(fs.readFileSync(file, 'utf8')).toBe(malformed);
  });

  it('refuses to uninstall from a malformed .mcp.json rather than rewriting it', () => {
    const root = project();
    const file = path.join(root, '.mcp.json');
    fs.writeFileSync(file, '{oops');
    expect(() => uninstallAssistant(assistantById('claude')!, root, false)).toThrow(CliError);
    expect(fs.readFileSync(file, 'utf8')).toBe('{oops');
  });
});

describe('detectServeLaunch', () => {
  it('falls back to an npx launcher when neither vg nor vibgrate is on PATH', () => {
    const launch = detectServeLaunch(() => null);
    expect(launch.command).toBe('npx');
    expect(launch.args).toEqual(['-y', '-p', '@vibgrate/cli', 'vg', 'serve']);
    expect(launch.note).toContain('not installed');
  });

  it('writes the detected launch into the MCP entry', () => {
    const root = project();
    installAssistant(assistantById('claude')!, { root, smallRepo: false, launch: detectServeLaunch(() => null) });
    const mcp = JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8'));
    expect(mcp.mcpServers.vg.command).toBe('npx');
  });
});

describe('P3 navigation deferral config', () => {
  it('hot core is a subset of the real tool set, deferred is the exact complement', () => {
    const names = new Set(TOOLS.map((t) => t.name));
    for (const h of HOT_TOOLS) expect(names.has(h)).toBe(true);
    const deferred = deferredToolNames();
    // hot + deferred partitions the whole set with no overlap.
    expect(new Set([...HOT_TOOLS, ...deferred]).size).toBe(TOOLS.length);
    for (const h of HOT_TOOLS) expect(deferred).not.toContain(h);
  });

  it('mcp_toolset block defers everything by default, loads only the hot core', () => {
    const cfg = navigationToolsetConfig() as {
      type: string;
      default_config: { defer_loading: boolean };
      configs: Record<string, { defer_loading: boolean }>;
    };
    expect(cfg.type).toBe('mcp_toolset');
    expect(cfg.default_config.defer_loading).toBe(true);
    for (const h of HOT_TOOLS) expect(cfg.configs[h].defer_loading).toBe(false);
    expect(Object.keys(cfg.configs)).toEqual([...HOT_TOOLS]);
  });

  it('vg install writes .vibgrate/mcp-navigation.json with hot core + deferred + toolset', () => {
    const root = project();
    const rel = writeNavigationConfig(root);
    expect(rel).toBe(path.join('.vibgrate', 'mcp-navigation.json'));
    const doc = JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
    expect(doc.hot_core).toEqual([...HOT_TOOLS]);
    expect(doc.deferred).toEqual(deferredToolNames());
    expect(doc.toolset.type).toBe('mcp_toolset');
    expect(typeof doc._readme).toBe('string');
  });
});
