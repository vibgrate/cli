import * as semver from 'semver';

/**
 * Concrete semver for scan JSON and SBOMs, including build metadata.
 *
 * `semver.clean` / `semver.valid` return `major.minor.patch[-pre]` and drop
 * the `+build` suffix. A lockfile token such as `1.2.3+build.4` is the
 * version those documents record. Precedence is unchanged: build metadata
 * does not participate in `semver.eq` / `semver.rcompare`.
 *
 * The leading `v` / `=` strip matches `semver.clean`, so `v1.2.3` is still
 * `1.2.3` and `v2.0.0+incompatible` is `2.0.0+incompatible`. Returns null
 * when `input` is not one semver (a range, a dist-tag, or a partial token).
 */
export function semverKeepingBuild(input: string): string | null {
  const cleaned = semver.clean(input);
  if (!cleaned) return null;
  // `clean` already accepted this token. Re-parse the same prefix it strips
  // so a leading `=` or `v` does not hide the build identifiers.
  const normalized = input.trim().replace(/^[=v]+/, '');
  const parsed = semver.parse(normalized);
  if (!parsed || parsed.build.length === 0) return cleaned;
  return `${cleaned}+${parsed.build.join('.')}`;
}
