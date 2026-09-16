import { describe, expect, it } from 'vitest';
import { DEFAULT_VGD_RSS_FRACTION, resolveVgdCacheOptions } from './vgd-memory.js';

const GIB = 1024 * 1024 * 1024;

describe('resolveVgdCacheOptions', () => {
  it('uses tight slot caps on a small machine', () => {
    const opts = resolveVgdCacheOptions({ totalmemBytes: 2 * GIB, env: {} });
    expect(opts.maxPerRepo).toBe(2);
    expect(opts.maxTotal).toBe(3);
    expect(opts.rssBudgetBytes).toBe(Math.floor(2 * GIB * DEFAULT_VGD_RSS_FRACTION));
  });

  it('keeps the plan defaults on a fat host', () => {
    const opts = resolveVgdCacheOptions({ totalmemBytes: 32 * GIB, env: {} });
    expect(opts.maxPerRepo).toBe(8);
    expect(opts.maxTotal).toBe(32);
  });

  it('honours VG_VGD_RSS_BUDGET_MB and 0 as disable', () => {
    expect(
      resolveVgdCacheOptions({ totalmemBytes: 8 * GIB, env: { VG_VGD_RSS_BUDGET_MB: '512' } }).rssBudgetBytes,
    ).toBe(512 * 1024 * 1024);
    expect(
      resolveVgdCacheOptions({ totalmemBytes: 8 * GIB, env: { VG_VGD_RSS_BUDGET_MB: '0' } }).rssBudgetBytes,
    ).toBe(0);
  });

  it('honours explicit slot caps', () => {
    const opts = resolveVgdCacheOptions({
      totalmemBytes: 2 * GIB,
      env: { VG_VGD_MAX_SLOTS: '10', VG_VGD_MAX_SLOTS_PER_REPO: '4' },
    });
    expect(opts.maxTotal).toBe(10);
    expect(opts.maxPerRepo).toBe(4);
  });
});
