import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { HOOK_NEEDLE, SESSION_START_NEEDLE, installClaudeHooks, installClaudeSessionStartHook, uninstallClaudeHooks, uninstallClaudeSessionStartHook } from './hooks.js';
import { hookContext, patternToQuery } from '../commands/hook.js';

/**
 * PreToolUse hook wiring: the settings.json merge must be idempotent and
 * fail-closed (a user's settings are never damaged), and the hook runtime's
 * failure mode is silence — it may only ever ADD context, never break a call.
 */

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'vg-hooks-'));
const read = (root: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8'));

describe('installClaudeHooks', () => {
  it('creates settings.json with a Grep|Glob PreToolUse entry', () => {
    const root = tmp();
    const r = installClaudeHooks(root, 'vg');
    expect(r.status).toBe('written');
    const s = read(root) as { hooks: { PreToolUse: { matcher: string; hooks: { command: string; timeout: number }[] }[] } };
    expect(s.hooks.PreToolUse).toHaveLength(1);
    expect(s.hooks.PreToolUse[0]!.matcher).toBe('Grep|Glob');
    expect(s.hooks.PreToolUse[0]!.hooks[0]!.command).toContain(HOOK_NEEDLE);
    expect(s.hooks.PreToolUse[0]!.hooks[0]!.timeout).toBe(10);
  });

  it('is idempotent and preserves foreign keys and foreign hooks verbatim', () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.claude', 'settings.json'),
      JSON.stringify({
        permissions: { allow: ['Bash(npm test)'] },
        hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-linter' }] }] },
      }),
    );
    expect(installClaudeHooks(root, 'vg').status).toBe('written');
    expect(installClaudeHooks(root, 'vg').status).toBe('unchanged');
    const s = read(root) as { permissions: unknown; hooks: { PreToolUse: { hooks: { command: string }[] }[] } };
    expect(s.permissions).toEqual({ allow: ['Bash(npm test)'] });
    expect(s.hooks.PreToolUse).toHaveLength(2);
    expect(s.hooks.PreToolUse[0]!.hooks[0]!.command).toBe('my-linter');
  });

  it('fails closed on unparseable settings — file left byte-identical', () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(root, '.claude', 'settings.json'), '{ broken json,,,');
    const r = installClaudeHooks(root, 'vg');
    expect(r.status).toBe('skipped');
    expect(fs.readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8')).toBe('{ broken json,,,');
  });

  it('uninstall removes only our entries and prunes empty structures', () => {
    const root = tmp();
    installClaudeHooks(root, 'vg');
    const s0 = read(root) as { hooks: { PreToolUse: unknown[] } };
    s0.hooks.PreToolUse.push({ matcher: 'Bash', hooks: [{ type: 'command', command: 'other-tool' }] });
    fs.writeFileSync(path.join(root, '.claude', 'settings.json'), JSON.stringify(s0));
    expect(uninstallClaudeHooks(root).status).toBe('written');
    const s = read(root) as { hooks: { PreToolUse: { hooks: { command: string }[] }[] } };
    expect(s.hooks.PreToolUse).toHaveLength(1);
    expect(s.hooks.PreToolUse[0]!.hooks[0]!.command).toBe('other-tool');
    // Removing again is a clean no-op.
    expect(uninstallClaudeHooks(root).status).toBe('unchanged');
  });
});

describe('hook runtime (pre-tool-use)', () => {
  it('patternToQuery strips regex metacharacters and classes', () => {
    expect(patternToQuery('collect(Mandate|Payment)\\d+')).toBe('collect Mandate Payment');
    expect(patternToQuery('^use[A-Z]\\w*')).toBe('use A-Z');
  });

  it('is silent for non-search tools, short patterns, bad payloads, and missing graphs', () => {
    const root = tmp();
    expect(hookContext('not json', root)).toBeNull();
    expect(hookContext(JSON.stringify({ tool_name: 'Bash', tool_input: { pattern: 'anything' } }), root)).toBeNull();
    expect(hookContext(JSON.stringify({ tool_name: 'Grep', tool_input: { pattern: 'ab' } }), root)).toBeNull();
    // Grep with a fine pattern but no graph on disk → silence, never an error.
    expect(hookContext(JSON.stringify({ tool_name: 'Grep', tool_input: { pattern: 'collectMandate' } }), root)).toBeNull();
  });
});

describe('installClaudeSessionStartHook — the listener self-heal for `vg install claude --compress`', () => {
  it('adds a SessionStart entry that starts or reuses the listener, beside any PreToolUse entries', () => {
    const root = tmp();
    installClaudeHooks(root, 'vg');
    const r = installClaudeSessionStartHook(root, '/usr/local/bin/vg');
    expect(r.status).toBe('written');
    const s = read(root) as { hooks: { PreToolUse: unknown[]; SessionStart: { hooks: { command: string; timeout: number }[] }[] } };
    expect(s.hooks.PreToolUse).toHaveLength(1);
    expect(s.hooks.SessionStart).toHaveLength(1);
    expect(s.hooks.SessionStart[0]!.hooks[0]!.command).toBe('/usr/local/bin/vg serve --compress --background --quiet');
    expect(s.hooks.SessionStart[0]!.hooks[0]!.command).toContain(SESSION_START_NEEDLE);
    expect(s.hooks.SessionStart[0]!.hooks[0]!.timeout).toBe(30);
  });

  it('is idempotent, updates its own entry in place, and leaves foreign SessionStart hooks alone', () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, '.claude'));
    fs.writeFileSync(path.join(root, '.claude', 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] } }));
    expect(installClaudeSessionStartHook(root, 'vg').status).toBe('written');
    expect(installClaudeSessionStartHook(root, 'vg').status).toBe('unchanged');
    expect(installClaudeSessionStartHook(root, '/opt/vg').status).toBe('written');
    const s = read(root) as { hooks: { SessionStart: { hooks: { command: string }[] }[] } };
    expect(s.hooks.SessionStart.flatMap((g) => g.hooks.map((h) => h.command))).toEqual(['echo hi', '/opt/vg serve --compress --background --quiet']);
  });

  it('uninstall removes only our entry and prunes what it emptied', () => {
    const root = tmp();
    installClaudeSessionStartHook(root, 'vg');
    expect(uninstallClaudeSessionStartHook(root).status).toBe('written');
    expect(read(root)).toEqual({});
    expect(uninstallClaudeSessionStartHook(root).status).toBe('unchanged');
    // A foreign hook survives.
    fs.writeFileSync(path.join(root, '.claude', 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] } }));
    installClaudeSessionStartHook(root, 'vg');
    uninstallClaudeSessionStartHook(root);
    const s = read(root) as { hooks: { SessionStart: { hooks: { command: string }[] }[] } };
    expect(s.hooks.SessionStart[0]!.hooks.map((h) => h.command)).toEqual(['echo hi']);
  });

  it('fails closed on unparseable settings', () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, '.claude'));
    fs.writeFileSync(path.join(root, '.claude', 'settings.json'), '{ not json');
    expect(installClaudeSessionStartHook(root, 'vg').status).toBe('skipped');
    expect(fs.readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8')).toBe('{ not json');
  });
});
