// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import * as semver from 'semver';
import type { VulnEcosystem } from '../types.js';

/**
 * Online breaking-change signal extraction for upgrade planning.
 *
 * Given a package and a current→latest version span, this resolves the package's
 * source repository (via ecosyste.ms) and scans its GitHub releases in that span
 * for breaking-change signals (BREAKING markers, removals, migrations, dropped
 * support, …). It enriches the offline upgrade-impact brief with *what* is likely
 * to break, not just *how far* behind you are.
 *
 * Everything here is **opt-in and best-effort**: any network failure, a package
 * with no resolvable GitHub repo, or an unparseable release degrades to
 * `source: 'none'` with empty signals — never a fabricated result. The pure
 * parsing helpers are exported for testing without the network.
 */

const FETCH_TIMEOUT_MS = 12_000;
const RELEASES_PER_PAGE = 100;

/** A release that carries breaking-change signals. */
export interface ReleaseSignals {
  version: string;
  tag: string;
  url: string | null;
  date: string | null;
  /** Distinct breaking-change signal labels found in the release notes. */
  signals: string[];
  /** A short excerpt around the first signal, for context. */
  excerpt: string | null;
}

/** Breaking-change signals across the releases between current and latest. */
export interface ChangelogSignals {
  source: 'github-releases' | 'none';
  repositoryUrl: string | null;
  releasesScanned: number;
  /** Releases in (current, latest] that carry signals, oldest → newest. */
  breakingReleases: ReleaseSignals[];
  notes: string[];
}

const EMPTY: ChangelogSignals = {
  source: 'none',
  repositoryUrl: null,
  releasesScanned: 0,
  breakingReleases: [],
  notes: [],
};

/** ecosyste.ms registry host per ecosystem (for repository resolution). */
const ECOSYSTEME_REGISTRY: Record<VulnEcosystem, string> = {
  npm: 'npmjs.org',
  pypi: 'pypi.org',
  maven: 'repo1.maven.org',
  nuget: 'nuget.org',
  go: 'proxy.golang.org',
  cargo: 'crates.io',
  composer: 'packagist.org',
  rubygems: 'rubygems.org',
  pub: 'pub.dev',
  hex: 'hex.pm',
};

/** Breaking-change phrase patterns → canonical signal labels. */
const SIGNAL_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /breaking[\s-]?change/i, label: 'breaking change' },
  { re: /\bbreaking\b/i, label: 'breaking' },
  { re: /\bdrop(?:ped|s)?\s+support\b/i, label: 'dropped support' },
  { re: /\bremoved?\b/i, label: 'removal' },
  { re: /\bdeprecat/i, label: 'deprecation' },
  { re: /\bmigrat/i, label: 'migration' },
  { re: /\brenamed?\b/i, label: 'rename' },
  { re: /\bno longer\b/i, label: 'no longer supported' },
  { re: /\bincompatib/i, label: 'incompatibility' },
];

/** Extract the distinct breaking-change signal labels present in some text. */
export function extractBreakingSignals(text: string | null | undefined): string[] {
  if (!text) return [];
  const found = new Set<string>();
  for (const { re, label } of SIGNAL_PATTERNS) {
    if (re.test(text)) found.add(label);
  }
  return [...found];
}

/** A short excerpt around the first breaking signal (single-line, trimmed). */
export function signalExcerpt(text: string | null | undefined): string | null {
  if (!text) return null;
  for (const { re } of SIGNAL_PATTERNS) {
    const m = re.exec(text);
    if (m && m.index != null) {
      const start = Math.max(0, m.index - 60);
      const slice = text.slice(start, m.index + 100).replace(/\s+/g, ' ').trim();
      return (start > 0 ? '…' : '') + slice + (m.index + 100 < text.length ? '…' : '');
    }
  }
  return null;
}

/** Parse owner/repo from a GitHub URL (https, git, ssh, with or without .git). */
export function parseGitHubRepo(url: string | null | undefined): { owner: string; repo: string } | null {
  if (!url) return null;
  const m = url.match(/github\.com[/:]([^/]+)\/([^/#?]+?)(?:\.git)?(?:[/#?].*)?$/i);
  return m ? { owner: m[1]!, repo: m[2]! } : null;
}

/** Derive a semver from a release tag, stripping `v`/`pkg@`/`pkg-` style prefixes. */
export function versionFromTag(tag: string, pkgName?: string): string | null {
  let t = tag.trim();
  if (pkgName) {
    for (const prefix of [`${pkgName}@`, `${pkgName}-v`, `${pkgName}-`, `${pkgName}/`, `${pkgName}_`]) {
      if (t.startsWith(prefix)) {
        t = t.slice(prefix.length);
        break;
      }
    }
  }
  t = t.replace(/^v/i, '');
  return semver.valid(semver.coerce(t));
}

/** Whether `version` is in the half-open span (from, to] (newer than current, up to latest). */
export function inUpgradeRange(version: string, fromVersion: string, toVersion: string): boolean {
  const v = semver.valid(semver.coerce(version));
  const from = semver.valid(semver.coerce(fromVersion));
  const to = semver.valid(semver.coerce(toVersion));
  if (!v || !from || !to) return false;
  return semver.gt(v, from) && semver.lte(v, to);
}

/** A raw GitHub release (the subset we read). */
export interface RawRelease {
  tag_name?: string;
  name?: string;
  body?: string;
  html_url?: string;
  published_at?: string;
  draft?: boolean;
  prerelease?: boolean;
}

/**
 * Pure: turn raw GitHub releases into the breaking-release list for an upgrade
 * span. Skips drafts; keeps releases in (from, to] that carry signals; sorts
 * oldest → newest.
 */
export function signalsFromReleases(
  releases: RawRelease[],
  fromVersion: string,
  toVersion: string,
  pkgName?: string,
): ReleaseSignals[] {
  const out: ReleaseSignals[] = [];
  for (const release of releases) {
    if (release.draft) continue;
    const tag = release.tag_name ?? release.name ?? '';
    const version = versionFromTag(tag, pkgName);
    if (!version || !inUpgradeRange(version, fromVersion, toVersion)) continue;
    const body = [release.name, release.body].filter(Boolean).join('\n');
    const signals = extractBreakingSignals(body);
    if (!signals.length) continue;
    out.push({
      version,
      tag,
      url: release.html_url ?? null,
      date: release.published_at ?? null,
      signals,
      excerpt: signalExcerpt(body),
    });
  }
  out.sort((a, b) => (semver.lt(a.version, b.version) ? -1 : semver.gt(a.version, b.version) ? 1 : a.tag.localeCompare(b.tag)));
  return out;
}

// ── Network (best-effort) ─────────────────────────────────────────────────────

async function fetchJson(url: string): Promise<unknown | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'user-agent': 'vibgrate-cli', accept: 'application/json' },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Resolve a package's source repository URL via ecosyste.ms. */
export async function resolveRepositoryUrl(ecosystem: VulnEcosystem, pkg: string): Promise<string | null> {
  const registry = ECOSYSTEME_REGISTRY[ecosystem];
  if (!registry) return null;
  const data = await fetchJson(
    `https://packages.ecosyste.ms/api/v1/registries/${registry}/packages/${encodeURIComponent(pkg)}`,
  );
  const repo = (data as Record<string, unknown> | null)?.repository_url;
  return typeof repo === 'string' ? repo : null;
}

/**
 * Resolve breaking-change signals for upgrading `pkg` from `fromVersion` to
 * `toVersion`. Best-effort and online; returns `source: 'none'` on any failure.
 *
 * @param opts.repositoryUrl skip ecosyste.ms resolution (e.g. for tests)
 * @param opts.fetchReleases inject the releases fetcher (e.g. for tests)
 */
export async function getChangelogSignals(
  ecosystem: VulnEcosystem | 'unknown',
  pkg: string,
  fromVersion: string | null,
  toVersion: string | null,
  opts: {
    repositoryUrl?: string | null;
    fetchReleases?: (owner: string, repo: string) => Promise<RawRelease[] | null>;
  } = {},
): Promise<ChangelogSignals> {
  if (ecosystem === 'unknown' || !fromVersion || !toVersion) return EMPTY;

  const repositoryUrl = opts.repositoryUrl ?? (await resolveRepositoryUrl(ecosystem, pkg));
  const gh = parseGitHubRepo(repositoryUrl);
  if (!gh) {
    return { ...EMPTY, repositoryUrl: repositoryUrl ?? null, notes: ['no GitHub repository resolved for this package — changelog signals unavailable'] };
  }

  const releases = opts.fetchReleases
    ? await opts.fetchReleases(gh.owner, gh.repo)
    : ((await fetchJson(`https://api.github.com/repos/${gh.owner}/${gh.repo}/releases?per_page=${RELEASES_PER_PAGE}`)) as RawRelease[] | null);
  if (!Array.isArray(releases)) {
    return { ...EMPTY, repositoryUrl, notes: ['could not fetch releases (network, rate limit, or no GitHub Releases)'] };
  }

  const breakingReleases = signalsFromReleases(releases, fromVersion, toVersion, pkg);
  const notes: string[] = [];
  if (releases.length === 0) notes.push('the repository publishes no GitHub Releases');
  else if (breakingReleases.length === 0) notes.push('no breaking-change signals found in releases across this version span');
  return { source: 'github-releases', repositoryUrl, releasesScanned: releases.length, breakingReleases, notes };
}
