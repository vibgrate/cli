import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

/** JS entry we can hand to `node` when re-spawning this CLI. */
const JS_ENTRY = /\.(c|m)?js$/i;

/**
 * How the user should re-invoke this CLI in a "next step" hint.
 *
 * A user who ran `npx @vibgrate/cli scan` has no *persistent* `vg` (or
 * `vibgrate`) on PATH, so a hint like `vg install` or `vg login` would fail for
 * them once the run ends. We answer the practical question "what will actually
 * run this CLI for this user again?" by checking whether an *installed* copy of
 * our binary is reachable on PATH:
 *
 *   installed `vg`       → `vg`                 (the normal installed case)
 *   installed `vibgrate` → `vibgrate`           (alias present, `vg` shadowed)
 *   neither              → `npx @vibgrate/cli`  (npx / not installed globally)
 *
 * "Installed" is the key qualifier: `npx` prepends its own throwaway
 * `_npx/<hash>/node_modules/.bin` to PATH for the run, so `which vg` finds a `vg`
 * that is genuinely ours yet gone the moment the process exits. That ephemeral
 * binary is excluded (see {@link isEphemeralNpxBinary}) so npx users get the npx
 * form, not a `vg` they can't call again.
 *
 * This is deliberately the same ladder `detectServeLaunch` uses for the MCP
 * launch command — the underlying question ("is an installed `vg` ours?") is
 * identical.
 */

/** The npx form that always works without a global install. */
export const NPX_INVOCATION = 'npx @vibgrate/cli';

/**
 * Locate `cmd` on PATH, returning its resolved path or null. Best-effort: a
 * missing command or an unavailable `which`/`where` both yield null.
 */
export function whichOnPath(cmd: string): string | null {
  try {
    const out = execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .trim()
      .split(/\r?\n/)[0];
    return out || null;
  } catch {
    return null;
  }
}

/**
 * Does this PATH entry launch *this* package? Symlink installs resolve into a
 * `…/@vibgrate/cli/…` directory; script shims (pnpm/bun/yarn, Windows .cmd)
 * reference the package path in their first bytes. Best-effort: unreadable or
 * unrecognisable entries count as foreign, which only makes callers pick a safer
 * fallback.
 */
export function isOwnBinary(binPath: string): boolean {
  try {
    const real = fs.realpathSync(binPath);
    if (/[\\/]@vibgrate[\\/]cli[\\/]/.test(real)) return true;
    const head = fs.readFileSync(real, { encoding: 'utf8' }).slice(0, 2048);
    return head.includes('@vibgrate/cli') || head.includes('vibgrate');
  } catch {
    return false;
  }
}

/**
 * Is this resolved binary an *ephemeral* npx-cache entry rather than a persistent
 * install? `npx @vibgrate/cli …` unpacks the package into an npm `_npx/<hash>/`
 * cache directory and prepends its `node_modules/.bin` to PATH for the duration
 * of the run — so `which vg` finds a `vg` that is *ours* yet vanishes the instant
 * the process exits. Treating that as an installed `vg` is exactly what made the
 * post-scan hints tell npx users to run `vg login`/`vg push`, commands they have
 * no `vg` on PATH for. npm's cache segment is `_npx` on every platform; we test
 * the raw PATH entry and its realpath (symlink shims resolve into the same tree).
 */
export function isEphemeralNpxBinary(binPath: string): boolean {
  const NPX_SEGMENT = /[\\/]_npx[\\/]/;
  if (NPX_SEGMENT.test(binPath)) return true;
  try {
    return NPX_SEGMENT.test(fs.realpathSync(binPath));
  } catch {
    return false;
  }
}

/**
 * Does this PATH entry launch *this* CLI in a way that will still work after the
 * current process exits? True only for a persistent install of our package — an
 * ephemeral npx-cache binary does not count, because the user cannot re-invoke it
 * by name. This is the predicate "next step" hints and the MCP launch command
 * must use, not {@link isOwnBinary} alone.
 */
export function isInstalledOwnBinary(binPath: string): boolean {
  return isOwnBinary(binPath) && !isEphemeralNpxBinary(binPath);
}

let cached: string | undefined;

/**
 * The command prefix a user should type to re-run this CLI (see module doc).
 * Memoized per-process: PATH does not change mid-run, and each call would
 * otherwise spawn `which`. Pass `which` to override lookup in tests, which also
 * bypasses the cache.
 */
export function resolveCliInvocation(which?: (cmd: string) => string | null): string {
  if (!which && cached !== undefined) return cached;
  const lookup = which ?? whichOnPath;

  const vg = lookup('vg');
  let result: string;
  if (vg && isInstalledOwnBinary(vg)) {
    result = 'vg';
  } else {
    const vibgrate = lookup('vibgrate');
    result = vibgrate && isInstalledOwnBinary(vibgrate) ? 'vibgrate' : NPX_INVOCATION;
  }

  if (!which) cached = result;
  return result;
}

/** Reset the memoized invocation. Test-only. */
export function resetCliInvocationCache(): void {
  cached = undefined;
}

/**
 * Absolute path of the JS file this process is running, when there is one.
 *
 * npm / pnpm / yarn / bun global bins are symlinks named `vg` (no `.js`
 * suffix). Callers that re-spawn as `node ${argv[1]} …` must realpath those,
 * otherwise `argv[1]` looks like a packaged binary and they exec
 * `node daemon …` — Node then exits 1 looking for a module named `daemon`.
 *
 * Returns null for a packaged binary, where `argv[1]` is the first user
 * argument (`daemon`, `scan`, …) rather than a script path.
 */
export function resolveSelfJsEntry(argv1: string = process.argv[1] ?? ''): string | null {
  if (!argv1) return null;
  const candidates = [argv1];
  try {
    const real = fs.realpathSync(argv1);
    if (real !== argv1) candidates.push(real);
  } catch {
    /* argv[1] is not a path (packaged binary: first CLI arg) */
  }
  for (const p of candidates) {
    if (!JS_ENTRY.test(p)) continue;
    return path.isAbsolute(p) ? p : path.resolve(p);
  }
  return null;
}

/**
 * Command + argv to re-invoke this CLI (detached daemon start, background
 * embed warm, …). Prefers `node <js-entry> <args>` so a global `vg` symlink
 * is not mistaken for a packaged binary.
 */
export function reinvokeCli(args: string[]): { command: string; argv: string[] } {
  const js = resolveSelfJsEntry();
  if (js) return { command: process.execPath, argv: [js, ...args] };
  return { command: process.argv[0] || 'vg', argv: args };
}
