/**
 * Firecracker L3 microVM backend (Fusion Runtime Phase 7 / ADR-002).
 *
 * L3 is the strongest isolation tier for `run_command` and untrusted patches:
 * a short-lived microVM with a pinned kernel + rootfs. This module is the pure
 * plan/argv surface and availability probe. When the binary or rootfs is
 * missing, {@link tryCreateFirecrackerEnv} returns null and the execution
 * ladder falls back to L2/L1/L0 — never silently claims L3.
 *
 * Real Firecracker boot is optional infrastructure; unit tests cover the pure
 * config + argv builders only.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { ExecutionEnv, ShellResult } from './execution-env.js';

export const FIRECRACKER_BACKEND_ID = 'firecracker' as const;

export interface FirecrackerPaths {
  /** Path to the `firecracker` binary. */
  binary: string;
  /** Guest kernel image (vmlinux). */
  kernel: string;
  /** Guest rootfs (ext4). */
  rootfs: string;
}

export interface FirecrackerPlanOptions {
  /** Writable host paths bind-mounted into the guest (project roots). */
  writableRoots: string[];
  /** Command to run inside the guest via the agent shim. */
  command: string;
  /** Guest memory MiB (default 512). */
  memSizeMib?: number;
  /** vCPU count (default 1). */
  vcpuCount?: number;
  /** Deny outbound network inside the microVM (default true). */
  denyNetwork?: boolean;
  /** Absolute path where the Firecracker JSON config will be written. */
  configPath: string;
}

/**
 * Pure Firecracker machine config (API shape). Deterministic for identical inputs.
 * Network interfaces omitted when denyNetwork is true.
 */
export function buildFirecrackerConfig(paths: FirecrackerPaths, options: FirecrackerPlanOptions): Record<string, unknown> {
  const bootArgs = [
    'console=ttyS0',
    'reboot=k',
    'panic=1',
    'pci=off',
    'init=/sbin/vg-agent-init',
    `vg_cmd=${encodeURIComponent(options.command)}`,
  ];
  if (options.denyNetwork !== false) bootArgs.push('vg_net=off');

  const cfg: Record<string, unknown> = {
    'boot-source': {
      kernel_image_path: paths.kernel,
      boot_args: bootArgs.join(' '),
    },
    drives: [
      {
        drive_id: 'rootfs',
        path_on_host: paths.rootfs,
        is_root_device: true,
        is_read_only: false,
      },
    ],
    'machine-config': {
      vcpu_count: options.vcpuCount ?? 1,
      mem_size_mib: options.memSizeMib ?? 512,
      smt: false,
    },
  };

  // Record bind intent for the host-side preflight (not a Firecracker native field).
  // Kept under a namespaced key so real FC ignores unknown fields when/if we switch.
  (cfg as { 'vg-writable-roots'?: string[] })['vg-writable-roots'] = [...options.writableRoots]
    .map((r) => path.resolve(r))
    .sort((a, b) => a.localeCompare(b));

  if (options.denyNetwork === false) {
    cfg['network-interfaces'] = [
      {
        iface_id: 'eth0',
        guest_mac: '06:00:00:00:00:01',
        host_dev_name: 'vmtap0',
      },
    ];
  }

  return cfg;
}

/** Pure argv: firecracker --config-file <path> (no API socket for one-shot plan). */
export function firecrackerArgv(binary: string, configPath: string): string[] {
  return [binary, '--config-file', configPath, '--no-api'];
}

/**
 * Resolve Firecracker paths from env or well-known defaults.
 * Returns null when binary or images are missing.
 */
export function resolveFirecrackerPaths(
  env: NodeJS.ProcessEnv = process.env,
  probeExists: (p: string) => boolean = (p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  },
): FirecrackerPaths | null {
  const binary = env.VIBGRATE_FIRECRACKER_BIN || which('firecracker') || '';
  const kernel = env.VIBGRATE_FIRECRACKER_KERNEL || '';
  const rootfs = env.VIBGRATE_FIRECRACKER_ROOTFS || '';
  if (!binary || !kernel || !rootfs) return null;
  if (!probeExists(binary) || !probeExists(kernel) || !probeExists(rootfs)) return null;
  return { binary, kernel, rootfs };
}

/**
 * Create an L3 ExecutionEnv when Firecracker + images are configured.
 * Returns null so the ladder can fall back cleanly.
 */
export function tryCreateFirecrackerEnv(options: {
  writableRoots: string[];
  denyNetwork?: boolean;
  paths?: FirecrackerPaths | null;
  reason?: string;
}): ExecutionEnv | null {
  const paths = options.paths === undefined ? resolveFirecrackerPaths() : options.paths;
  if (!paths) return null;

  const denyNetwork = options.denyNetwork !== false;
  const reason = options.reason ?? 'L3 Firecracker microVM';

  return {
    tier: 'L3',
    label: 'firecracker',
    reason,
    run(command, runOpts): ShellResult {
      const roots = options.writableRoots.length ? options.writableRoots : [runOpts.cwd];
      const configPath = path.join(
        process.env.TMPDIR || '/tmp',
        `vg-fc-${process.pid}-${Date.now()}.json`,
      );
      const cfg = buildFirecrackerConfig(paths, {
        writableRoots: roots,
        command,
        denyNetwork,
        configPath,
      });
      try {
        fs.writeFileSync(configPath, `${JSON.stringify(cfg, null, 2)}\n`, {
          encoding: 'utf8',
          mode: 0o600,
        });
        const argv = firecrackerArgv(paths.binary, configPath);
        const res = spawnSync(argv[0]!, argv.slice(1), {
          encoding: 'utf8',
          timeout: runOpts.timeoutMs ?? 120_000,
          maxBuffer: 10 * 1024 * 1024,
          env: process.env,
        });
        const stdout = (res.stdout ?? '') + (res.stderr ? `\n${res.stderr}` : '');
        // If firecracker is not actually runnable, surface a clear exit.
        if (res.error) {
          return {
            stdout: `firecracker failed to start: ${res.error.message}`,
            exitCode: 1,
          };
        }
        return { stdout, exitCode: res.status ?? 1 };
      } finally {
        try {
          fs.unlinkSync(configPath);
        } catch {
          /* best-effort */
        }
      }
    },
  };
}

function which(bin: string): string | null {
  try {
    const res = spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], {
      encoding: 'utf8',
    });
    if (res.status !== 0) return null;
    const line = (res.stdout ?? '').trim().split('\n')[0]?.trim();
    return line || null;
  } catch {
    return null;
  }
}
