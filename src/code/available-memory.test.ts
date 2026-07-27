import { describe, it, expect } from 'vitest';
import {
  parseVmStatAvailableBytes,
  parseMeminfoAvailableBytes,
  availableRamBytes,
} from './available-memory.js';

const GiB = 1024 ** 3;

describe('parseVmStatAvailableBytes', () => {
  const sample = `
Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               4085.
Pages active:                          1327248.
Pages inactive:                        1338930.
Pages speculative:                       10198.
Pages throttled:                             0.
Pages wired down:                       520856.
Pages purgeable:                            72.
File-backed pages:                      824709.
Anonymous pages:                       1851667.
`;

  it('sums free + inactive + speculative + purgeable × page size', () => {
    const bytes = parseVmStatAvailableBytes(sample);
    expect(bytes).not.toBeNull();
    // (4085 + 1338930 + 10198 + 72) * 16384
    const pages = 4085 + 1338930 + 10198 + 72;
    expect(bytes).toBe(pages * 16384);
    expect(bytes! / GiB).toBeGreaterThan(15);
  });

  it('returns null on empty / unparseable input', () => {
    expect(parseVmStatAvailableBytes('')).toBeNull();
    expect(parseVmStatAvailableBytes('not vm_stat')).toBeNull();
  });

  it('defaults page size when header missing but Pages free present', () => {
    const bare = 'Pages free: 1000.\nPages inactive: 0.\nPages speculative: 0.\nPages purgeable: 0.\n';
    expect(parseVmStatAvailableBytes(bare)).toBe(1000 * 4096);
  });
});

describe('parseMeminfoAvailableBytes', () => {
  it('reads MemAvailable', () => {
    const content = `MemTotal:       16384000 kB
MemFree:          500000 kB
MemAvailable:    8192000 kB
Buffers:          100000 kB
`;
    expect(parseMeminfoAvailableBytes(content)).toBe(8192000 * 1024);
  });

  it('falls back to MemFree when MemAvailable is missing', () => {
    const content = `MemTotal: 8000000 kB
MemFree:  2000000 kB
`;
    expect(parseMeminfoAvailableBytes(content)).toBe(2000000 * 1024);
  });

  it('returns null on empty input', () => {
    expect(parseMeminfoAvailableBytes('')).toBeNull();
    expect(parseMeminfoAvailableBytes('junk')).toBeNull();
  });
});

describe('availableRamBytes', () => {
  it('returns node freemem on win32 (no platform probe)', () => {
    const n = availableRamBytes('win32', () => 4 * GiB);
    expect(n).toBe(4 * GiB);
  });

  it('never returns a negative value from freemem', () => {
    expect(availableRamBytes('win32', () => -1)).toBe(0);
    expect(availableRamBytes('win32', () => Number.NaN)).toBe(0);
  });

  it('on darwin prefers platform available when larger than freemem', () => {
    // Live probe (when vm_stat works) or freemem fallback — either way ≥ freemem.
    const freemem = 100 * 1024 * 1024; // 100 MiB pretend bare free
    const n = availableRamBytes('darwin', () => freemem);
    expect(n).toBeGreaterThanOrEqual(freemem);
  });
});
