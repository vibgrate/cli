import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { HOOK_NEEDLE, installClaudeHooks, uninstallClaudeHooks } from './hooks.js';
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
