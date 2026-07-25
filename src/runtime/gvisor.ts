/**
 * gVisor (runsc) L2 sandbox backend (Fusion Runtime Phase 7 / ADR-002).
 *
 * When `runsc` is on PATH and a rootfs is configured, L2 can use gVisor instead
 * of (or as fallback from) firejail. Pure plan/argv builders; execution is
 * best-effort and falls back cleanly when images are missing.
 *
 * Env:
 *   VIBGRATE_GVISOR_BIN     — path to runsc (default: runsc on PATH)
 *   VIBGRATE_GVISOR_ROOTFS  — OCI/rootfs bundle directory
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { ExecutionEnv, ShellResult } from './execution-env.js';

export interface GvisorPaths {
  binary: string;
  rootfs: string;
}

export interface GvisorPlanOptions {
  writableRoots: string[];
  command: string;
  denyNetwork?: boolean;
  cwd?: string;
}

/**
 * Pure argv for a one-shot runsc do (no long-lived container).
 * Network is unshared when denyNetwork is true.
 */
export function gvisorArgv(paths: GvisorPaths, options: GvisorPlanOptions): string[] {
  const args: string[] = [
    paths.binary,
    '--rootless=true',
    '--network=' + (options.denyNetwork === false ? 'host' : 'none'),
    'do',
    '--rootfs-path',
    paths.rootfs,
  ];
  // Bind writable project roots into the sandbox.
  for (const root of [...options.writableRoots].map((r) => path.resolve(r)).sort()) {
    args.push('--bind', `${root}:${root}:rw`);
  }
  if (options.cwd) {
    args.push('--cwd', path.resolve(options.cwd));
  }
  args.push('--', '/bin/sh', '-c', options.command);
  return args;
}

export function resolveGvisorPaths(
  env: NodeJS.ProcessEnv = process.env,
  probeExists: (p: string) => boolean = (p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  },
  which: (bin: string) => string | null = whichBin,
): GvisorPaths | null {
  const binary = env.VIBGRATE_GVISOR_BIN || which('runsc') || '';
  const rootfs = env.VIBGRATE_GVISOR_ROOTFS || '';
  if (!binary || !rootfs) return null;
  if (!probeExists(binary) || !probeExists(rootfs)) return null;
  return { binary, rootfs };
}

export function tryCreateGvisorEnv(options: {
  writableRoots: string[];
  denyNetwork?: boolean;
  paths?: GvisorPaths | null;
  reason?: string;
}): ExecutionEnv | null {
  const paths = options.paths === undefined ? resolveGvisorPaths() : options.paths;
  if (!paths) return null;
  const denyNetwork = options.denyNetwork !== false;
  return {
    tier: 'L2',
    label: 'gvisor',
    reason: options.reason ?? 'L2 gVisor runsc',
    run(command, runOpts): ShellResult {
      const roots = options.writableRoots.length ? options.writableRoots : [runOpts.cwd];
      const argv = gvisorArgv(paths, {
        writableRoots: roots,
        command,
        denyNetwork,
        cwd: runOpts.cwd,
      });
      const res = spawnSync(argv[0]!, argv.slice(1), {
        encoding: 'utf8',
        timeout: runOpts.timeoutMs ?? 120_000,
        maxBuffer: 10 * 1024 * 1024,
        env: process.env,
      });
      if (res.error) {
        return { stdout: `gvisor failed to start: ${res.error.message}`, exitCode: 1 };
      }
      const stdout = (res.stdout ?? '') + (res.stderr ? `\n${res.stderr}` : '');
      return { stdout, exitCode: res.status ?? 1 };
    },
  };
}

function whichBin(bin: string): string | null {
  try {
    const res = spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], {
      encoding: 'utf8',
    });
    if (res.status !== 0) return null;
    return (res.stdout ?? '').trim().split('\n')[0]?.trim() || null;
  } catch {
    return null;
  }
}
