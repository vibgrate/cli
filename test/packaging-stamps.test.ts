import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FORMULA_TEMPLATE,
  SCOOP_TEMPLATE,
  FORMULA_STAMPED,
  SCOOP_STAMPED,
  npmTarballUrl,
  stampFormula,
  stampScoop,
  renderStamped,
  versionFromStampedFormula,
  sha256FromStampedFormula,
} from '../scripts/stamp-packaging.mjs';
import { visibilityUrl, packageSettingsUrl, setPackagePublic } from '../scripts/ghcr-set-visibility.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Fixture pin for the pure stamp helpers — not the live tap/bucket copies.
// Those are refreshed by the Packaging workflow after each npm publish and
// must not be frozen here, or the next calendar bump breaks CI.
const VERSION = '2026.1.1';
const SHA = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const CALENDAR_VERSION = /^\d{4}\.\d{1,4}\.\d+$/;

describe('npmTarballUrl', () => {
  it('points at the published @vibgrate/cli tarball', () => {
    expect(npmTarballUrl(VERSION)).toBe(
      `https://registry.npmjs.org/@vibgrate/cli/-/cli-${VERSION}.tgz`,
    );
  });
});

describe('stampFormula', () => {
  it('pins version and sha256 and leaves no placeholders', () => {
    const src = fs.readFileSync(path.join(ROOT, FORMULA_TEMPLATE), 'utf8');
    const out = stampFormula(src, { version: VERSION, sha256: SHA });
    expect(out).toContain(`cli-${VERSION}.tgz`);
    expect(out).toContain(`sha256 "${SHA}"`);
    expect(out).not.toContain('VERSION');
    expect(out).not.toContain('REPLACED_AT_RELEASE');
  });

  it('rejects a template without the release tokens', () => {
    expect(() => stampFormula('class Vg < Formula\nend\n', { version: VERSION, sha256: SHA })).toThrow(
      /VERSION or REPLACED_AT_RELEASE/,
    );
  });

  it('round-trips version and sha256 through the stamped-formula parsers', () => {
    const src = fs.readFileSync(path.join(ROOT, FORMULA_TEMPLATE), 'utf8');
    const out = stampFormula(src, { version: VERSION, sha256: SHA });
    expect(versionFromStampedFormula(out)).toBe(VERSION);
    expect(sha256FromStampedFormula(out)).toBe(SHA);
  });
});

describe('stampScoop', () => {
  it('pins the version and leaves no placeholders', () => {
    const src = fs.readFileSync(path.join(ROOT, SCOOP_TEMPLATE), 'utf8');
    const out = stampScoop(src, {
      version: VERSION,
      sha256: SHA,
      tarballUrl: npmTarballUrl(VERSION),
    });
    const parsed = JSON.parse(out);
    expect(parsed.version).toBe(VERSION);
    expect(out).not.toContain('REPLACED_AT_RELEASE');
    // Scoop expands `$version` from the manifest at install time.
    expect(parsed.installer.script[0]).toContain('@vibgrate/cli@$version');
  });
});

describe('stamped-formula parsers', () => {
  it('returns empty strings when the formula is unpinned', () => {
    expect(versionFromStampedFormula('class Vg < Formula\nend\n')).toBe('');
    expect(sha256FromStampedFormula('  sha256 "REPLACED_AT_RELEASE"\n')).toBe('');
  });
});

describe('live stamped packaging files', () => {
  const formula = fs.readFileSync(path.join(ROOT, FORMULA_STAMPED), 'utf8');
  const scoopText = fs.readFileSync(path.join(ROOT, SCOOP_STAMPED), 'utf8');
  const version = versionFromStampedFormula(formula);
  const sha256 = sha256FromStampedFormula(formula);

  it('Homebrew formula pins a calendar version and a 64-hex npm tarball sha256', () => {
    expect(version).toMatch(CALENDAR_VERSION);
    expect(sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(formula).toContain(`cli-${version}.tgz`);
    expect(formula).toContain(`sha256 "${sha256}"`);
    expect(formula).toContain('class Vg < Formula');
    expect(formula).not.toContain('REPLACED_AT_RELEASE');
  });

  it('Scoop manifest version matches the Homebrew formula pin', () => {
    const scoop = JSON.parse(scoopText);
    expect(scoop.version).toBe(version);
    expect(scoop.depends).toBe('nodejs');
    expect(scoop.installer.script[0]).toContain('@vibgrate/cli@$version');
    expect(scoopText).not.toContain('REPLACED_AT_RELEASE');
  });

  it('stamped files match the templates rendered from their own pin', () => {
    const rendered = renderStamped({
      version,
      sha256,
      tarballUrl: npmTarballUrl(version),
    });
    expect(formula).toBe(rendered.formula);
    expect(scoopText).toBe(rendered.scoop);
  });
});

describe('ghcr-set-visibility', () => {
  it('encodes nested Helm package names as a single path segment', () => {
    expect(visibilityUrl('vibgrate', 'charts/vibgrate')).toBe(
      'https://api.github.com/orgs/vibgrate/packages/container/charts%2Fvibgrate/visibility',
    );
    expect(visibilityUrl('vibgrate', 'cli')).toBe(
      'https://api.github.com/orgs/vibgrate/packages/container/cli/visibility',
    );
    expect(packageSettingsUrl('vibgrate', 'charts/vibgrate')).toBe(
      'https://github.com/orgs/vibgrate/packages/container/charts/vibgrate/settings',
    );
  });

  it('returns the owner settings URL when the API refuses', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      text: async () => '{"message":"You need admin access"}',
    }));
    const result = await setPackagePublic({
      owner: 'vibgrate',
      packageName: 'charts/vibgrate',
      token: 'test-token',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(403);
    expect(result.settingsUrl).toContain('/orgs/vibgrate/packages/container/charts/vibgrate/settings');
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toContain('charts%2Fvibgrate');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({ visibility: 'public' });
  });

  it('treats a missing token as an owner-action case, not a crash', async () => {
    const result = await setPackagePublic({
      owner: 'vibgrate',
      packageName: 'cli',
      token: '',
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('no token');
  });
});
