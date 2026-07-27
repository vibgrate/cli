/**
 * Platform-accurate *available* RAM for model fit decisions.
 *
 * Node's `os.freemem()` is wrong for this use case on several OSes:
 *   - **macOS**: returns only completely unused pages. The kernel fills the rest
 *     with file cache that is reclaimable under pressure — Activity Monitor's
 *     "Available" (and what a model can actually use). Under normal load
 *     `os.freemem()` often reports ~0 while many GiB are available.
 *   - **Linux**: prefers `/proc/meminfo` `MemAvailable` (reclaim-aware) over
 *     `MemFree`.
 *   - **Windows**: `os.freemem()` already maps to available physical memory
 *     (`GlobalMemoryStatusEx.ullAvailPhys`) and is fine.
 *
 * Fit/install gates must use *available* memory, not bare free pages, or
 * Spark/Flow falsely report "0.0 GiB free after reserves" on machines with
 * tens of GiB of reclaimable RAM.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';

/**
 * Parse `vm_stat` output into reclaimable/available bytes.
 * Available ≈ free + inactive + speculative + purgeable (file cache that the
 * kernel can reclaim). Returns null when the output is unparseable.
 */
export function parseVmStatAvailableBytes(stdout: string): number | null {
  if (!stdout || !/Pages free:/i.test(stdout)) return null;
  const pageMatch = stdout.match(/page size of (\d+) bytes/i);
  // Apple Silicon is typically 16 KiB; Intel macOS 4 KiB. Default conservatively.
  const pageSize = pageMatch ? Number(pageMatch[1]) : 4096;
  if (!Number.isFinite(pageSize) || pageSize <= 0) return null;

  const pages = (label: string): number => {
    // Lines look like: "Pages free:                               4085."
    const m = stdout.match(new RegExp(`${label}:\\s+(\\d+)\\.?`, 'i'));
    return m ? Number(m[1]) : 0;
  };

  const free = pages('Pages free');
  const inactive = pages('Pages inactive');
  const speculative = pages('Pages speculative');
  const purgeable = pages('Pages purgeable');
  const totalPages = free + inactive + speculative + purgeable;
  if (!Number.isFinite(totalPages) || totalPages < 0) return null;
  return totalPages * pageSize;
}

/**
 * Parse `/proc/meminfo` for MemAvailable (kB). Falls back to MemFree when
 * MemAvailable is missing (very old kernels).
 */
export function parseMeminfoAvailableBytes(content: string): number | null {
  if (!content) return null;
  const avail = content.match(/^MemAvailable:\s+(\d+)\s*kB/im);
  if (avail) {
    const n = Number(avail[1]) * 1024;
    return Number.isFinite(n) && n >= 0 ? n : null;
  }
  const free = content.match(/^MemFree:\s+(\d+)\s*kB/im);
  if (free) {
    const n = Number(free[1]) * 1024;
    return Number.isFinite(n) && n >= 0 ? n : null;
  }
  return null;
}

/** Best-effort available RAM in bytes. Never throws; falls back to os.freemem(). */
export function availableRamBytes(
  platform: NodeJS.Platform = process.platform,
  freemem: () => number = () => os.freemem(),
): number {
  const nodeFree = safeNonNeg(freemem());
  let platformAvail: number | null = null;

  if (platform === 'darwin') {
    platformAvail = readMacAvailableBytes();
  } else if (platform === 'linux') {
    platformAvail = readLinuxAvailableBytes();
  }
  // win32 and others: Node freemem is already "available".

  // Prefer the larger of the two when both exist — never under-report
  // availability because of a stale/partial platform probe.
  if (platformAvail != null && platformAvail > nodeFree) return platformAvail;
  return nodeFree;
}

function readMacAvailableBytes(): number | null {
  try {
    const res = spawnSync('vm_stat', [], { encoding: 'utf8', timeout: 3000 });
    if (res.status !== 0 || typeof res.stdout !== 'string') return null;
    return parseVmStatAvailableBytes(res.stdout);
  } catch {
    return null;
  }
}

function readLinuxAvailableBytes(): number | null {
  try {
    const content = fs.readFileSync('/proc/meminfo', 'utf8');
    return parseMeminfoAvailableBytes(content);
  } catch {
    return null;
  }
}

function safeNonNeg(n: number): number {
  return Number.isFinite(n) && n > 0 ? n : 0;
}
