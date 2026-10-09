import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadPackageVersionManifest } from '../src/core-open/package-version-manifest.js';
import { GoCache } from '../src/core-open/scanners/go-cache.js';
import { scanGoProjects } from '../src/core-open/scanners/go-scanner.js';
import {
  collectVulnTargets,
  generateVulnerabilityFindings,
  scanVulnerabilities,
} from '../src/core-open/scanners/vulnerability-scanner.js';
import { Semaphore } from '../src/core-open/utils/semaphore.js';
import { extractManifests } from '../src/engine/manifests.js';

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../examples/go-pseudo-versions');
const docs = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../DOCS.md'), 'utf8');

const REPORTED = [
  'GHSA-example-incompatible-range',
  'GHSA-example-pseudo-base',
  'GHSA-example-pseudo-explicit-clean',
  'GHSA-example-replaced',
  'GHSA-example-tagged',
];

const ABSENT = [
  'GHSA-example-pseudo-next',
  'GHSA-example-pseudo-explicit-v',
  'GHSA-example-incompatible-v1',
  'GHSA-example-incompatible-explicit',
  'GHSA-example-indirect',
  'GHSA-example-excluded',
];

describe('Go pseudo-versions and +incompatible (vg scan --vulns, offline)', () => {
  it('records require versions and skips replace, exclude, and indirect', async () => {
    const [project] = await scanGoProjects(fixtureDir, new GoCache(new Semaphore(1), undefined, true));
    const resolved = Object.fromEntries(project.dependencies.map((d) => [d.package, d.resolvedVersion]));
    expect(resolved).toEqual({
      'example.com/oldmajor': '2.0.0+incompatible',
      'example.com/pseudo-base': '0.0.0-20191109021931-daa7c04131f5',
      'example.com/pseudo-next': '1.2.4-0.20210101120000-abcdefabcdef',
      'example.com/replaced-mod': '1.0.0',
      'example.com/tagged': '1.2.3',
    });
  });

  it('matches the local advisory manifest with the documented ids', async () => {
    const [project] = await scanGoProjects(fixtureDir, new GoCache(new Semaphore(1), undefined, true));
    const manifest = await loadPackageVersionManifest(path.join(fixtureDir, 'package-versions.json'));
    const targets = collectVulnTargets([project]);
    const result = await scanVulnerabilities(targets, { sem: new Semaphore(1), offline: true, manifest });
    const ids = generateVulnerabilityFindings(result).map((f) => f.details?.advisoryId);
    expect(ids).toEqual(REPORTED);
    for (const id of ABSENT) expect(ids).not.toContain(id);
    expect(result.packages.map((p) => p.version)).toEqual([
      '2.0.0+incompatible',
      '0.0.0-20191109021931-daa7c04131f5',
      '1.0.0',
      '1.2.3',
    ]);
  });

  it('keeps require modules in the code graph and drops replace and exclude targets', () => {
    const names = extractManifests(fixtureDir)
      .nodes.filter((n) => n.kind === 'external')
      .map((n) => n.name)
      .sort();
    expect(names).toEqual([
      'example.com/indirect-mod',
      'example.com/oldmajor',
      'example.com/pseudo-base',
      'example.com/pseudo-next',
      'example.com/replaced-mod',
      'example.com/tagged',
    ]);
    expect(names).not.toContain('example.com/excluded-mod');
    expect(names).not.toContain('example.com/fork-only');
    expect(names).not.toContain('example.com/fork');
  });

  it('documents the same advisory ids and the offline check command', () => {
    for (const id of [...REPORTED, ...ABSENT]) expect(docs).toContain(id);
    expect(docs).toContain(
      'vg scan --vulns --offline --package-manifest package-versions.json --format json --out go-vulns.json',
    );
  });
});
