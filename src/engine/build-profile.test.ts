import { describe, expect, it } from 'vitest';
import {
  CODE_ONLY_LANGS,
  LEAN_EXCLUDE_GLOBS,
  TEST_EXCLUDE_GLOBS,
  parseBuildProfile,
  resolveBuildProfile,
} from './build-profile.js';

const FAT = { totalmemBytes: 16 * 1024 * 1024 * 1024, freememBytes: 8 * 1024 * 1024 * 1024 };
const THIN = { totalmemBytes: 2 * 1024 * 1024 * 1024, freememBytes: 400 * 1024 * 1024 };

describe('parseBuildProfile', () => {
  it('accepts lean|map|full and rejects junk', () => {
    expect(parseBuildProfile('lean')).toBe('lean');
    expect(parseBuildProfile('MAP')).toBe('map');
    expect(parseBuildProfile('full')).toBe('full');
    expect(parseBuildProfile('xl')).toBeUndefined();
    expect(parseBuildProfile(undefined)).toBeUndefined();
  });
});

describe('resolveBuildProfile', () => {
  it('defaults to full on a fat host and does not invent excludes', () => {
    const plan = resolveBuildProfile({ ...FAT });
    expect(plan.profile).toBe('full');
    expect(plan.exclude).toEqual([]);
    expect(plan.fast).toBe(false);
    expect(plan.autoStartDaemon).toBe(true);
    expect(plan.publish).toBe(true);
    expect(plan.notice).toBeUndefined();
  });

  it('lean drops tests/docs/examples and will not auto-start vgd', () => {
    const plan = resolveBuildProfile({ profile: 'lean', ...FAT });
    expect(plan.jobs).toBe(1);
    expect(plan.analysisTier).toBe('xl');
    expect(plan.fast).toBe(true);
    expect(plan.autoStartDaemon).toBe(false);
    expect(plan.publish).toBe(false);
    expect(plan.only).toEqual([...CODE_ONLY_LANGS]);
    for (const g of LEAN_EXCLUDE_GLOBS) expect(plan.exclude).toContain(g);
  });

  it('keeps an explicit --only list on lean', () => {
    const plan = resolveBuildProfile({ profile: 'lean', only: ['ts', 'js'], ...FAT });
    expect(plan.only).toEqual(['ts', 'js']);
  });

  it('--no-tests on full only adds test globs', () => {
    const plan = resolveBuildProfile({ noTests: true, ...FAT });
    expect(plan.profile).toBe('full');
    expect(plan.exclude).toEqual([...TEST_EXCLUDE_GLOBS]);
    expect(plan.exclude).not.toContain('docs/**');
  });

  it('degrades an implicit full to lean on a thin host', () => {
    const plan = resolveBuildProfile({ ...THIN });
    expect(plan.profile).toBe('lean');
    expect(plan.degradedFrom).toBe('full');
    expect(plan.notice).toMatch(/--profile full/);
    expect(plan.jobs).toBe(1);
    expect(plan.autoStartDaemon).toBe(false);
  });

  it('does not degrade an explicit --profile full on a thin host', () => {
    const plan = resolveBuildProfile({ profile: 'full', forceFull: true, ...THIN });
    expect(plan.profile).toBe('full');
    expect(plan.degradedFrom).toBeUndefined();
    expect(plan.autoStartDaemon).toBe(true);
  });

  it('composes caller excludes ahead of profile globs', () => {
    const plan = resolveBuildProfile({
      profile: 'map',
      exclude: ['vendor-src/**'],
      ...FAT,
    });
    expect(plan.exclude[0]).toBe('vendor-src/**');
    expect(plan.exclude).toContain('test/**');
    expect(plan.analysisTier).toBe('large');
    expect(plan.publish).toBe(true);
    expect(plan.autoStartDaemon).toBe(false);
  });
});
