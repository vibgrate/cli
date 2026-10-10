import { describe, expect, it } from 'vitest';
import { recordedSemver, splitBuildMetadata } from './recorded-semver.js';

describe('recordedSemver', () => {
  it('keeps build metadata that semver.valid would drop', () => {
    expect(recordedSemver('1.2.3+build.7')).toBe('1.2.3+build.7');
    expect(recordedSemver('v2.0.0+incompatible')).toBe('2.0.0+incompatible');
    expect(recordedSemver('1.2.3-rc.1+sha.abc')).toBe('1.2.3-rc.1+sha.abc');
    expect(recordedSemver('=v1.2.3+001')).toBe('1.2.3+001');
  });

  it('still drops a leading v when there is no build suffix', () => {
    expect(recordedSemver('v1.2.3')).toBe('1.2.3');
    expect(recordedSemver('v0.0.0-20191109021931-daa7c04131f5')).toBe('0.0.0-20191109021931-daa7c04131f5');
  });

  it('returns null for a partial version or junk', () => {
    expect(recordedSemver('v1.2')).toBeNull();
    expect(recordedSemver('not-a-version')).toBeNull();
    expect(recordedSemver(null)).toBeNull();
    expect(recordedSemver(undefined)).toBeNull();
    expect(recordedSemver('   ')).toBeNull();
  });
});

describe('splitBuildMetadata', () => {
  it('peels a dotted build id off the numeric core', () => {
    expect(splitBuildMetadata('1.2.3+build.7')).toEqual({ core: '1.2.3', build: '+build.7' });
    expect(splitBuildMetadata('1.2.3')).toEqual({ core: '1.2.3', build: '' });
    expect(splitBuildMetadata('1.+')).toEqual({ core: '1.', build: '+' });
  });
});
