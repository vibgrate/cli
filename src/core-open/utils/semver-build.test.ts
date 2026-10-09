import { describe, expect, it } from 'vitest';
import { semverKeepingBuild } from './semver-build.js';

describe('semverKeepingBuild', () => {
  it('keeps build metadata that semver.clean would drop', () => {
    expect(semverKeepingBuild('1.2.3+build.4')).toBe('1.2.3+build.4');
    expect(semverKeepingBuild('1.2.3-rc.1+build.4')).toBe('1.2.3-rc.1+build.4');
    expect(semverKeepingBuild('v2.0.0+incompatible')).toBe('2.0.0+incompatible');
    expect(semverKeepingBuild('=1.2.3+build.4')).toBe('1.2.3+build.4');
  });

  it('matches semver.clean when there is no build metadata', () => {
    expect(semverKeepingBuild('v1.2.3')).toBe('1.2.3');
    expect(semverKeepingBuild('=v1.2.3')).toBe('1.2.3');
    expect(semverKeepingBuild('  v1.2.3  ')).toBe('1.2.3');
    expect(semverKeepingBuild('v0.0.0-20191109021931-daa7c04131f5')).toBe(
      '0.0.0-20191109021931-daa7c04131f5',
    );
  });

  it('returns null for a range or a partial token', () => {
    expect(semverKeepingBuild('^1.2.3')).toBeNull();
    expect(semverKeepingBuild('1.2')).toBeNull();
    expect(semverKeepingBuild('')).toBeNull();
  });
});
