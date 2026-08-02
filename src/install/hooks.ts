import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * PreToolUse hook wiring for Claude Code (`vg install claude --hooks`): merge
 * a Grep/Glob enrichment hook into the PROJECT's `.claude/settings.json`, so
 * the host's own searches arrive annotated with graph context (see
 * commands/hook.ts for the runtime).
 *
 * Merge contract — this must never damage a user's settings:
 *  - the file is parsed as strict JSON; anything unparseable is left
 *    untouched and reported (fail closed, never overwrite);
 *  - only the `hooks.PreToolUse` array is extended; every other key —
 *    including hook entries we did not write — is preserved verbatim;
 *  - idempotent: an existing entry whose command contains the vg needle is
 *    updated in place, never duplicated;
 *  - project-scoped on purpose: `.claude/settings.json` travels with the
 *    repo, so review sees the hook and teammates get it deliberately —
 *    nothing is written into `~/.claude`.
 */

export const HOOK_NEEDLE = 'vg hook pre-tool-use';
const MATCHER = 'Grep|Glob';
const HOOK_TIMEOUT_S = 10;

interface HookEntry {
  type: 'command';
  command: string;
  timeout?: number;
}
interface HookGroup {
  matcher?: string;
  hooks?: HookEntry[];
}

export interface HookInstallResult {
  file: string;
  status: 'written' | 'unchanged' | 'skipped';
  note?: string;
}

function hookCommand(vgBin: string): string {
  return `${vgBin} hook pre-tool-use`;
}

export function installClaudeHooks(root: string, vgBin = 'vg'): HookInstallResult {
  const file = path.join(root, '.claude', 'settings.json');
  const rel = path.join('.claude', 'settings.json');
  let settings: Record<string, unknown> = {};
  if (fs.existsSync(file)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { file: rel, status: 'skipped', note: 'settings.json is not a JSON object — left untouched' };
      }
      settings = parsed as Record<string, unknown>;
    } catch {
      return { file: rel, status: 'skipped', note: 'settings.json is not parseable JSON — left untouched (fix it and rerun)' };
    }
  }

  const hooks = (settings.hooks ??= {}) as Record<string, unknown>;
  if (typeof hooks !== 'object' || Array.isArray(hooks)) {
    return { file: rel, status: 'skipped', note: '"hooks" is not an object — left untouched' };
  }
  const pre = (hooks.PreToolUse ??= []) as HookGroup[];
  if (!Array.isArray(pre)) {
    return { file: rel, status: 'skipped', note: '"hooks.PreToolUse" is not an array — left untouched' };
  }

  const desired: HookEntry = { type: 'command', command: hookCommand(vgBin), timeout: HOOK_TIMEOUT_S };
  // Idempotency: find any entry we own (needle match), update in place.
  for (const group of pre) {
    for (const entry of group.hooks ?? []) {
      if (typeof entry.command === 'string' && entry.command.includes(HOOK_NEEDLE)) {
        if (entry.command === desired.command && entry.timeout === desired.timeout && group.matcher === MATCHER) {
          return { file: rel, status: 'unchanged' };
        }
        entry.command = desired.command;
        entry.timeout = desired.timeout;
        group.matcher = MATCHER;
        writeSettings(file, settings);
        return { file: rel, status: 'written', note: 'updated existing vg hook entry' };
      }
    }
  }
  pre.push({ matcher: MATCHER, hooks: [desired] });
  writeSettings(file, settings);
  return { file: rel, status: 'written' };
}

/** Remove every hook entry we own; prunes groups/keys left empty. */
export function uninstallClaudeHooks(root: string): HookInstallResult {
  const file = path.join(root, '.claude', 'settings.json');
  const rel = path.join('.claude', 'settings.json');
  if (!fs.existsSync(file)) return { file: rel, status: 'unchanged' };
  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return { file: rel, status: 'skipped', note: 'settings.json is not parseable JSON — left untouched' };
  }
  const hooks = settings.hooks as Record<string, unknown> | undefined;
  const pre = hooks?.PreToolUse as HookGroup[] | undefined;
  if (!Array.isArray(pre)) return { file: rel, status: 'unchanged' };
  let removed = false;
  for (const group of pre) {
    const before = group.hooks?.length ?? 0;
    group.hooks = (group.hooks ?? []).filter((e) => !(typeof e.command === 'string' && e.command.includes(HOOK_NEEDLE)));
    if (group.hooks.length !== before) removed = true;
  }
  const kept = pre.filter((g) => (g.hooks?.length ?? 0) > 0);
  if (!removed) return { file: rel, status: 'unchanged' };
  if (kept.length) (hooks as Record<string, unknown>).PreToolUse = kept;
  else delete (hooks as Record<string, unknown>).PreToolUse;
  if (hooks && Object.keys(hooks).length === 0) delete settings.hooks;
  writeSettings(file, settings);
  return { file: rel, status: 'written' };
}

function writeSettings(file: string, settings: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
}
