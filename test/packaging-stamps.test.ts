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
} from '../scripts/stamp-packaging.mjs';
import { visibilityUrl, packageSettingsUrl, setPackagePublic } from '../scripts/ghcr-set-visibility.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = '2026.914.1';
const SHA = '21c164080d1ba33dc53d604a8754ffa0079daa9c8b771a9053c224a2c43877bf';

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

describe('live stamped packaging files', () => {
  it('Homebrew formula is pinned to 2026.914.1 with the npm tarball sha256', () => {
    const formula = fs.readFileSync(path.join(ROOT, FORMULA_STAMPED), 'utf8');
    expect(formula).toContain(`cli-${VERSION}.tgz`);
    expect(formula).toContain(`sha256 "${SHA}"`);
    expect(formula).toContain('class Vg < Formula');
    expect(formula).not.toContain('REPLACED_AT_RELEASE');
  });

  it('Scoop manifest is pinned to 2026.914.1', () => {
    const scoop = JSON.parse(fs.readFileSync(path.join(ROOT, SCOOP_STAMPED), 'utf8'));
    expect(scoop.version).toBe(VERSION);
    expect(scoop.depends).toBe('nodejs');
    expect(scoop.installer.script[0]).toContain('@vibgrate/cli@$version');
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
