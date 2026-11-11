/**
 * `Gemfile.lock` is an SBOM lockfile. Gems under `GEM` `specs:` are
 * components, including ones the Gemfile did not declare. A platform suffix
 * is not part of the version. The project gem (`PATH` or `GIT` `remote: .`)
 * is omitted. A git or path gem with any other remote is kept.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RubyGemsCache } from '../src/core-open/scanners/rubygems-cache.js';
import { scanRubyProjects } from '../src/core-open/scanners/ruby-scanner.js';
import { Semaphore } from '../src/core-open/utils/semaphore.js';
import { collectLockfileGraph, toCycloneDx, toSpdx } from '../src/reporting/commands/sbom.js';
import type { ProjectScan, ScanArtifact } from '../src/reporting/types.js';

const GEMFILE = `source 'https://rubygems.org'

gem 'rails', '~> 7.1'
`;

const LOCKFILE = `PATH
  remote: .
  specs:
    myapp (0.1.0)
      rails (~> 7.1)

GIT
  remote: .
  revision: abcdef
  specs:
    local-git-app (0.0.1)

GIT
  remote: https://github.com/example/devise.git
  revision: 0123456789abcdef0123456789abcdef01234567
  specs:
    devise (4.9.3)
      bcrypt (~> 3.0)

PATH
  remote: vendor/gems
  specs:
    billing (0.1.0)

GEM
  remote: https://rubygems.org/
  specs:
    bcrypt (3.1.20)
    nokogiri (1.16.0-x86_64-linux)
      racc (~> 1.4)
    racc (1.7.3)
    rails (7.1.3)
      actionpack (= 7.1.3)
    actionpack (7.1.3)

PLATFORMS
  ruby
  x86_64-linux

DEPENDENCIES
  rails (~> 7.1)
  devise!
  billing!

BUNDLED WITH
  2.5.3
`;

function artifact(rootPath: string, projects: ProjectScan[]): ScanArtifact {
  return {
    schemaVersion: '1.0',
    timestamp: '2026-02-19T00:00:00.000Z',
    vibgrateVersion: '0.0.1',
    rootPath,
    drift: {
      score: 0,
      riskLevel: 'low',
      components: { runtimeScore: 0, frameworkScore: 0, dependencyScore: 0, eolScore: 0 },
    },
    findings: [],
    projects,
  };
}

describe('sbom export: Gemfile.lock', () => {
  let root: string;

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('exports transitive gems with gem purls and strips a platform suffix', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-gemfile-lock-'));
    fs.writeFileSync(path.join(root, 'Gemfile'), GEMFILE);
    fs.writeFileSync(path.join(root, 'Gemfile.lock'), LOCKFILE);

    const projects = await scanRubyProjects(root, new RubyGemsCache(new Semaphore(1), undefined, true));
    const scanArtifact = artifact(path.basename(root), projects);
    const graph = collectLockfileGraph(scanArtifact, root);
    const cdx = toCycloneDx(scanArtifact, graph) as {
      components: Array<{ name: string; version: string; purl?: string; scope?: string; properties: Array<{ name: string; value: string }> }>;
      dependencies?: unknown;
    };
    const spdx = toSpdx(scanArtifact, graph) as {
      packages: Array<{
        name: string;
        versionInfo?: string;
        annotations?: Array<{ comment?: string }>;
        externalRefs?: Array<{ referenceLocator?: string }>;
      }>;
      relationships?: unknown;
    };

    const again = toCycloneDx(scanArtifact, graph);
    expect(JSON.stringify(again)).toBe(JSON.stringify(cdx));

    expect(projects[0]?.dependencies.map((dep) => dep.package)).toEqual(['rails']);
    expect(cdx.dependencies).toBeUndefined();
    expect(spdx.relationships).toBeUndefined();

    const rows = cdx.components.map((component) => ({
      name: component.name,
      version: component.version,
      purl: component.purl,
      scope: component.properties.find((property) => property.name === 'vibgrate:scope')?.value,
    }));
    expect(rows).toEqual([
      { name: 'actionpack', version: '7.1.3', purl: 'pkg:gem/actionpack@7.1.3', scope: 'transitive' },
      { name: 'bcrypt', version: '3.1.20', purl: 'pkg:gem/bcrypt@3.1.20', scope: 'transitive' },
      { name: 'billing', version: '0.1.0', purl: 'pkg:gem/billing@0.1.0', scope: 'transitive' },
      { name: 'devise', version: '4.9.3', purl: 'pkg:gem/devise@4.9.3', scope: 'transitive' },
      { name: 'nokogiri', version: '1.16.0', purl: 'pkg:gem/nokogiri@1.16.0', scope: 'transitive' },
      { name: 'racc', version: '1.7.3', purl: 'pkg:gem/racc@1.7.3', scope: 'transitive' },
      { name: 'rails', version: '7.1.3', purl: 'pkg:gem/rails@7.1.3', scope: 'direct' },
    ]);
    expect(rows.map((row) => row.name)).not.toContain('myapp');
    expect(rows.map((row) => row.name)).not.toContain('local-git-app');
    expect(cdx.components.find((component) => component.name === 'nokogiri')?.scope).toBeUndefined();

    const locators = spdx.packages.flatMap((pkg) => pkg.externalRefs?.map((ref) => ref.referenceLocator) ?? []);
    expect(locators).toContain('pkg:gem/nokogiri@1.16.0');
    expect(locators).toContain('pkg:gem/actionpack@7.1.3');
    const nokogiri = spdx.packages.find((pkg) => pkg.name === 'nokogiri');
    expect(nokogiri?.versionInfo).toBe('1.16.0');
    expect(nokogiri?.annotations?.some((note) => note.comment?.includes('scope=transitive'))).toBe(true);
    const rails = spdx.packages.find((pkg) => pkg.name === 'rails');
    expect(rails?.annotations?.some((note) => note.comment?.includes('scope=direct'))).toBe(true);
  });
});
