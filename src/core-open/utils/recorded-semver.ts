import * as semver from 'semver';

/**
 * Concrete SemVer from a lockfile or manifest, including build metadata.
 *
 * `semver.clean` and `semver.valid` return `SemVer#version`, which omits the
 * `+` suffix. Precedence ignores that suffix, so drift and range checks stay
 * the same, but scan JSON and `vg sbom` name the version that was written.
 * A leading `v` or `=` is still removed. Returns null when `input` is not SemVer.
 */
export function recordedSemver(input: string | null | undefined): string | null {
  if (input == null) return null;
  const trimmed = input.trim().replace(/^[=v]+/, '');
  if (!trimmed) return null;
  const parsed = semver.parse(trimmed);
  if (!parsed) return null;
  return parsed.build.length > 0 ? `${parsed.version}+${parsed.build.join('.')}` : parsed.version;
}

/** Separate a SemVer build suffix so padding the numeric core cannot swallow it. */
export function splitBuildMetadata(version: string): { core: string; build: string } {
  const plus = version.indexOf('+');
  if (plus < 0) return { core: version, build: '' };
  return { core: version.slice(0, plus), build: version.slice(plus) };
}
