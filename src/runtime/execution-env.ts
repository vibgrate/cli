/**
 * Execution environment ladder (Fusion Runtime Phase 7 / ADR-002).
 *
 * The agent kernel stays the same; only the substrate that runs shell commands
 * changes. L0 is the host process. L1 is path-restricted isolation:
 *   · macOS — Seatbelt via `sandbox-exec` (writes limited to project roots + temp)
 *   · Linux — bubblewrap (`bwrap`) when available (same write scope; optional net deny)
 * When the platform cannot provide a real isolator, resolveExecutionEnv falls
 * back to L0 with an explicit reason rather than failing closed for developers.
 *
 * L2 uses firejail when available (Linux). L3 uses Firecracker when the binary
 * and guest images are configured (`VIBGRATE_FIRECRACKER_*`); otherwise the
 * ladder falls back to best available ≤ L2.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { firejailArgv } from './sandbox-backend.js';
import { tryCreateFirecrackerEnv } from './firecracker.js';
import { tryCreateGvisorEnv } from './gvisor.js';

export type SecurityTier = 'L0' | 'L1' | 'L2' | 'L3';

export interface ShellResult {
  stdout: string;
  exitCode: number;
}

export interface ExecutionEnv {
  readonly tier: SecurityTier;
  /** Human-readable substrate description. */
  readonly label: string;
  /** Why this tier was selected (capability / config). */
  readonly reason: string;
  run(command: string, options: { cwd: string; timeoutMs?: number }): ShellResult;
}

export interface SecurityCapabilities {
  platform: NodeJS.Platform;
  /** Linux Landlock filesystem present (best-effort probe). */
  landlock: boolean;
  /** macOS Seatbelt / sandbox-exec available. */
  seatbelt: boolean;
  /** Linux bubblewrap available (practical L1 isolator). */
  bubblewrap: boolean;
  /** Linux firejail available (L2 process jail). */
  firejail: boolean;
  /** Linux gVisor runsc available (L2 reserved until wired). */
  gvisor: boolean;
}

export interface ResolveExecutionEnvOptions {
  capabilities?: SecurityCapabilities;
  /**
   * Absolute paths the sandboxed process may write. Defaults to the command
   * `cwd` at run time (plus system temp). Pass federation member roots so
   * multi-root agent sessions can write into every workspace folder.
   */
  writableRoots?: string[];
  /**
   * Deny outbound network inside the sandbox (default true for L1). Parent
   * process model API calls are unaffected — only `run_command` / verify shell.
   */
  denyNetwork?: boolean;
}

/** Probe host isolation capabilities without throwing. */
export function detectSecurityCapabilities(platform: NodeJS.Platform = process.platform): SecurityCapabilities {
  if (platform === 'linux') {
    return {
      platform,
      landlock: linuxLandlockAvailable(),
      seatbelt: false,
      bubblewrap: commandOnPath('bwrap'),
      firejail: commandOnPath('firejail'),
      gvisor: commandOnPath('runsc'),
    };
  }
  if (platform === 'darwin') {
    return {
      platform,
      landlock: false,
      seatbelt: macSeatbeltAvailable(),
      bubblewrap: false,
      firejail: false,
      gvisor: false,
    };
  }
  return { platform, landlock: false, seatbelt: false, bubblewrap: false, firejail: false, gvisor: false };
}

/**
 * Resolve an execution env for the requested tier.
 * L3 → Firecracker when configured; else L2 → firejail; else L1 Seatbelt/bwrap.
 * Landlock sysfs alone is not enough without a userspace enforcer.
 */
export function resolveExecutionEnv(
  requested: SecurityTier = 'L0',
  options: ResolveExecutionEnvOptions = {},
): ExecutionEnv {
  const caps = options.capabilities ?? detectSecurityCapabilities();
  const writableRoots = normalizeRoots(options.writableRoots);
  const denyNetwork = options.denyNetwork !== false;

  if (requested === 'L0') return createHostExecutionEnv('explicit L0');

  if (requested === 'L3') {
    const l3 = tryCreateFirecrackerEnv({
      writableRoots,
      denyNetwork,
      reason: 'L3 Firecracker microVM',
    });
    if (l3) return l3;
    const l2 = tryCreateL2Env(caps, writableRoots, denyNetwork, requested);
    if (l2) return l2;
    const l1 = tryCreateL1Env(caps, writableRoots, denyNetwork, requested);
    if (l1) return l1;
    return createHostExecutionEnv('L3 not available (Firecracker images unset) — falling back to L0');
  }

  if (requested === 'L2') {
    const l2 = tryCreateL2Env(caps, writableRoots, denyNetwork, requested);
    if (l2) return l2;
    const l1 = tryCreateL1Env(caps, writableRoots, denyNetwork, requested);
    if (l1) return l1;
    return createHostExecutionEnv(`${requested} not available — falling back to L0`);
  }

  if (requested === 'L1') {
    const l1 = tryCreateL1Env(caps, writableRoots, denyNetwork, requested);
    if (l1) return l1;
    return createHostExecutionEnv('L1 requested but no Seatbelt/bubblewrap — falling back to L0');
  }

  return createHostExecutionEnv('unknown tier — falling back to L0');
}

export function createHostExecutionEnv(reason = 'host process'): ExecutionEnv {
  return {
    tier: 'L0',
    label: 'host',
    reason,
    run(command, options) {
      return hostRun(command, options);
    },
  };
}

/**
 * Build a macOS Seatbelt (sandbox-exec) profile that allows reads broadly and
 * restricts writes to the given roots + system temp. Pure — used by tests.
 */
export function buildSeatbeltProfile(
  writableRoots: string[],
  options: { denyNetwork?: boolean; tempRoots?: string[] } = {},
): string {
  const roots = uniqueResolved([...writableRoots, ...(options.tempRoots ?? defaultTempRoots())]);
  const lines: string[] = [
    '(version 1)',
    '(deny default)',
    '(allow process*)',
    '(allow sysctl-read)',
    '(allow mach*)',
    '(allow system-socket)',
    '(allow file-read*)',
    '(allow file-write-data (literal "/dev/null"))',
    '(allow file-write-data (literal "/dev/zero"))',
    '(allow file-ioctl)',
    '(allow file-write* (literal "/dev/tty"))',
    '(allow file-write* (literal "/dev/dtracehelper"))',
  ];
  for (const root of roots) {
    const escaped = escapeSeatbeltPath(root);
    lines.push(`(allow file-write* (subpath "${escaped}"))`);
    // macOS often exposes paths under /private — allow both forms when applicable.
    if (root.startsWith('/var/') || root.startsWith('/tmp')) {
      lines.push(`(allow file-write* (subpath "${escapeSeatbeltPath(`/private${root}`)}"))`);
    }
    if (root.startsWith('/private/var/') || root.startsWith('/private/tmp')) {
      const short = root.slice('/private'.length);
      lines.push(`(allow file-write* (subpath "${escapeSeatbeltPath(short)}"))`);
    }
  }
  if (options.denyNetwork !== false) {
    lines.push('(deny network*)');
  } else {
    lines.push('(allow network*)');
  }
  // POSIX IPC / signals used by shells and test runners.
  lines.push('(allow ipc*)');
  lines.push('(allow signal)');
  lines.push('(allow pseudo-tty)');
  return `${lines.join('\n')}\n`;
}

/** Pure: argv for sandbox-exec -f <profile> /bin/sh -c <command>. */
export function seatbeltArgv(profilePath: string, command: string): string[] {
  return ['sandbox-exec', '-f', profilePath, '/bin/sh', '-c', command];
}

/** Pure: argv for bwrap with write binds for roots (read-only host + bind writables). */
export function bubblewrapArgv(
  writableRoots: string[],
  command: string,
  options: { denyNetwork?: boolean; cwd?: string } = {},
): string[] {
  const args: string[] = [
    'bwrap',
    '--die-with-parent',
    '--ro-bind',
    '/',
    '/',
    '--dev',
    '/dev',
    '--proc',
    '/proc',
    '--tmpfs',
    '/tmp',
  ];
  const roots = uniqueResolved(writableRoots);
  for (const root of roots) {
    // Re-bind writable over the read-only mount.
    args.push('--bind', root, root);
  }
  // System temp must remain writable for compilers / test runners.
  for (const t of defaultTempRoots()) {
    if (fs.existsSync(t)) args.push('--bind', t, t);
  }
  if (options.denyNetwork !== false) {
    args.push('--unshare-net');
  }
  if (options.cwd) {
    args.push('--chdir', options.cwd);
  }
  args.push('--', '/bin/sh', '-c', command);
  return args;
}

// ── internals ──────────────────────────────────────────────────────────────

function tryCreateL2Env(
  caps: SecurityCapabilities,
  writableRoots: string[],
  denyNetwork: boolean,
  requested: SecurityTier,
): ExecutionEnv | null {
  if (caps.firejail) {
    return createFirejailEnv(
      requested === 'L2'
        ? 'L2 firejail process jail'
        : `${requested} requested; using L2 firejail`,
      writableRoots,
      denyNetwork,
    );
  }
  // Prefer firejail when both exist; otherwise gVisor when configured.
  if (caps.gvisor) {
    const gv = tryCreateGvisorEnv({
      writableRoots,
      denyNetwork,
      reason:
        requested === 'L2'
          ? 'L2 gVisor runsc'
          : `${requested} requested; using L2 gVisor`,
    });
    if (gv) return gv;
  }
  return null;
}

function tryCreateL1Env(
  caps: SecurityCapabilities,
  writableRoots: string[],
  denyNetwork: boolean,
  requested: SecurityTier,
): ExecutionEnv | null {
  if (caps.seatbelt) {
    return createSeatbeltEnv(
      requested === 'L1'
        ? 'L1 Seatbelt (sandbox-exec) path isolation'
        : `${requested} requested; using L1 Seatbelt (sandbox-exec)`,
      writableRoots,
      denyNetwork,
    );
  }
  if (caps.bubblewrap) {
    return createBubblewrapEnv(
      requested === 'L1'
        ? 'L1 bubblewrap path isolation'
        : `${requested} requested; using L1 bubblewrap`,
      writableRoots,
      denyNetwork,
      caps.landlock,
    );
  }
  // Landlock sysfs without a userspace enforcer cannot isolate from Node alone.
  if (caps.landlock) {
    return null;
  }
  return null;
}

function createFirejailEnv(reason: string, writableRoots: string[], denyNetwork: boolean): ExecutionEnv {
  return {
    tier: 'L2',
    label: 'firejail',
    reason,
    run(command, options) {
      const roots = writableRoots.length ? writableRoots : [options.cwd];
      if (!roots.some((r) => isPathInside(options.cwd, r))) {
        roots.push(path.resolve(options.cwd));
      }
      const argv = firejailArgv(roots, command, { denyNetwork, cwd: options.cwd });
      const res = spawnSync(argv[0]!, argv.slice(1), {
        encoding: 'utf8',
        timeout: options.timeoutMs ?? 120_000,
        maxBuffer: 10 * 1024 * 1024,
        env: process.env,
      });
      const stdout = (res.stdout ?? '') + (res.stderr ? `\n${res.stderr}` : '');
      return { stdout, exitCode: res.status ?? 1 };
    },
  };
}

function createSeatbeltEnv(reason: string, writableRoots: string[], denyNetwork: boolean): ExecutionEnv {
  return {
    tier: 'L1',
    label: 'seatbelt',
    reason,
    run(command, options) {
      const roots = writableRoots.length ? writableRoots : [options.cwd];
      const profile = buildSeatbeltProfile(roots, { denyNetwork });
      const profilePath = path.join(os.tmpdir(), `vg-seatbelt-${process.pid}-${Date.now()}.sb`);
      try {
        fs.writeFileSync(profilePath, profile, { encoding: 'utf8', mode: 0o600 });
        const argv = seatbeltArgv(profilePath, command);
        const res = spawnSync(argv[0]!, argv.slice(1), {
          cwd: options.cwd,
          encoding: 'utf8',
          timeout: options.timeoutMs ?? 120_000,
          maxBuffer: 10 * 1024 * 1024,
          env: process.env,
        });
        const stdout = (res.stdout ?? '') + (res.stderr ? `\n${res.stderr}` : '');
        return { stdout, exitCode: res.status ?? 1 };
      } finally {
        try {
          fs.unlinkSync(profilePath);
        } catch {
          /* best-effort cleanup */
        }
      }
    },
  };
}

function createBubblewrapEnv(
  reason: string,
  writableRoots: string[],
  denyNetwork: boolean,
  landlockPresent: boolean,
): ExecutionEnv {
  return {
    tier: 'L1',
    label: landlockPresent ? 'bwrap+landlock-host' : 'bwrap',
    reason,
    run(command, options) {
      const roots = writableRoots.length ? writableRoots : [options.cwd];
      // Ensure cwd is writable even if caller omitted it.
      if (!roots.some((r) => isPathInside(options.cwd, r))) {
        roots.push(path.resolve(options.cwd));
      }
      const argv = bubblewrapArgv(roots, command, { denyNetwork, cwd: options.cwd });
      const res = spawnSync(argv[0]!, argv.slice(1), {
        encoding: 'utf8',
        timeout: options.timeoutMs ?? 120_000,
        maxBuffer: 10 * 1024 * 1024,
        env: process.env,
      });
      const stdout = (res.stdout ?? '') + (res.stderr ? `\n${res.stderr}` : '');
      return { stdout, exitCode: res.status ?? 1 };
    },
  };
}

function hostRun(command: string, options: { cwd: string; timeoutMs?: number }): ShellResult {
  const res = spawnSync(command, {
    cwd: options.cwd,
    shell: true,
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 120_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  const stdout = (res.stdout ?? '') + (res.stderr ? `\n${res.stderr}` : '');
  return { stdout, exitCode: res.status ?? 1 };
}

function linuxLandlockAvailable(): boolean {
  try {
    return fs.existsSync('/sys/kernel/security/landlock') || fs.existsSync('/proc/sys/kernel/landlock');
  } catch {
    return false;
  }
}

function macSeatbeltAvailable(): boolean {
  return commandOnPath('sandbox-exec');
}

function commandOnPath(bin: string): boolean {
  try {
    const res = spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], { encoding: 'utf8' });
    return res.status === 0 && Boolean(res.stdout?.trim());
  } catch {
    return false;
  }
}

function defaultTempRoots(): string[] {
  // Prefer the process temp dir (e.g. /var/folders/.../T) — never the entire
  // /var/folders tree, or every mkdtemp sibling would be writable under L1.
  const roots: string[] = [];
  try {
    roots.push(os.tmpdir());
  } catch {
    /* ignore */
  }
  if (process.env.TMPDIR) roots.push(process.env.TMPDIR);
  if (process.env.TMP) roots.push(process.env.TMP);
  if (process.env.TEMP) roots.push(process.env.TEMP);
  roots.push('/tmp', '/private/tmp');
  return uniqueResolved(roots.filter((r) => typeof r === 'string' && r.length > 0));
}

function normalizeRoots(roots: string[] | undefined): string[] {
  if (!roots?.length) return [];
  return uniqueResolved(roots.filter((r) => typeof r === 'string' && r.trim()).map((r) => r.trim()));
}

function uniqueResolved(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of paths) {
    try {
      const abs = path.resolve(p);
      if (seen.has(abs)) continue;
      seen.add(abs);
      out.push(abs);
    } catch {
      /* skip bad paths */
    }
  }
  return out.sort((a, b) => a.localeCompare(b));
}

function escapeSeatbeltPath(p: string): string {
  // Seatbelt subpath strings: escape backslash and double-quote.
  return p.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function isPathInside(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
