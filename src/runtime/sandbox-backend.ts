/**
 * Sandbox backend ladder interface (Fusion Phase 7 / ADR-002).
 *
 * L0 host · L1 Seatbelt/bwrap · L2 process jail (firejail / gVisor runsc when
 * available) · L3 microVM (Firecracker when binary + guest images are configured).
 *
 * The agent kernel only sees {@link ExecutionEnv}; this module classifies and
 * resolves stronger backends without changing tool semantics.
 */

import { spawnSync } from 'node:child_process';
import type { SecurityTier } from './execution-env.js';
import { resolveFirecrackerPaths } from './firecracker.js';

export type SandboxBackendId = 'host' | 'seatbelt' | 'bwrap' | 'firejail' | 'gvisor' | 'firecracker';

export interface SandboxBackendInfo {
  id: SandboxBackendId;
  /** Maps to security tier this backend satisfies. */
  tier: SecurityTier;
  available: boolean;
  /** Why available/unavailable. */
  reason: string;
}

export interface SandboxCapabilities {
  platform: NodeJS.Platform;
  backends: SandboxBackendInfo[];
  /** Best tier this host can enforce. */
  bestTier: SecurityTier;
}

/**
 * Probe optional L2+ backends. Pure over spawn probes — never throws.
 * Firecracker is available only when binary + kernel + rootfs resolve.
 */
export function detectSandboxCapabilities(platform: NodeJS.Platform = process.platform): SandboxCapabilities {
  const backends: SandboxBackendInfo[] = [];

  if (platform === 'darwin') {
    const seatbelt = commandOnPath('sandbox-exec');
    backends.push({
      id: 'seatbelt',
      tier: 'L1',
      available: seatbelt,
      reason: seatbelt ? 'sandbox-exec present' : 'sandbox-exec not found',
    });
  }

  if (platform === 'linux') {
    const bwrap = commandOnPath('bwrap');
    backends.push({
      id: 'bwrap',
      tier: 'L1',
      available: bwrap,
      reason: bwrap ? 'bubblewrap present' : 'bwrap not found',
    });
    const firejail = commandOnPath('firejail');
    backends.push({
      id: 'firejail',
      tier: 'L2',
      available: firejail,
      reason: firejail ? 'firejail present' : 'firejail not found',
    });
    const runsc = commandOnPath('runsc');
    backends.push({
      id: 'gvisor',
      tier: 'L2',
      available: runsc,
      reason: runsc ? 'gVisor runsc present' : 'runsc not found',
    });
  }

  const fc = resolveFirecrackerPaths();
  backends.push({
    id: 'firecracker',
    tier: 'L3',
    available: !!fc,
    reason: fc
      ? `Firecracker configured (${fc.binary})`
      : 'Firecracker unset — set VIBGRATE_FIRECRACKER_BIN, _KERNEL, _ROOTFS',
  });

  backends.push({
    id: 'host',
    tier: 'L0',
    available: true,
    reason: 'always available',
  });

  let bestTier: SecurityTier = 'L0';
  for (const b of backends) {
    if (!b.available) continue;
    if (tierRank(b.tier) > tierRank(bestTier)) bestTier = b.tier;
  }

  return { platform, backends, bestTier };
}

/** Pure: pick the strongest available backend that satisfies `requested`. */
export function selectSandboxBackend(
  requested: SecurityTier,
  caps: SandboxCapabilities = detectSandboxCapabilities(),
): SandboxBackendInfo {
  const want = tierRank(requested);
  // Prefer exact tier match, then best available ≤ requested, then any higher if requested and available.
  const available = caps.backends.filter((b) => b.available);
  const exact = available.find((b) => b.tier === requested && b.id !== 'host');
  if (exact) return exact;
  // Stronger than requested is fine (more isolation).
  const stronger = available
    .filter((b) => tierRank(b.tier) >= want && b.id !== 'host')
    .sort((a, b) => tierRank(a.tier) - tierRank(b.tier));
  if (stronger[0]) return stronger[0];
  // Fall back to best ≤ requested.
  const weaker = available
    .filter((b) => tierRank(b.tier) < want)
    .sort((a, b) => tierRank(b.tier) - tierRank(a.tier));
  if (weaker[0]) return weaker[0];
  return available.find((b) => b.id === 'host') ?? {
    id: 'host',
    tier: 'L0',
    available: true,
    reason: 'fallback host',
  };
}

/**
 * Build firejail argv for L2 path isolation (Linux).
 * Network denied by default when denyNetwork is true.
 */
export function firejailArgv(
  writableRoots: string[],
  command: string,
  options: { denyNetwork?: boolean; cwd?: string } = {},
): string[] {
  const args: string[] = [
    'firejail',
    '--quiet',
    '--noprofile',
    '--private-tmp',
    '--nonewprivs',
    '--nogroups',
  ];
  if (options.denyNetwork !== false) args.push('--net=none');
  for (const root of writableRoots) {
    args.push(`--whitelist=${root}`);
  }
  if (options.cwd) args.push(`--whitelist=${options.cwd}`);
  args.push('--', '/bin/sh', '-c', command);
  return args;
}

function tierRank(t: SecurityTier): number {
  if (t === 'L0') return 0;
  if (t === 'L1') return 1;
  if (t === 'L2') return 2;
  return 3;
}

function commandOnPath(bin: string): boolean {
  try {
    const res = spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], { encoding: 'utf8' });
    return res.status === 0 && Boolean(res.stdout?.trim());
  } catch {
    return false;
  }
}
