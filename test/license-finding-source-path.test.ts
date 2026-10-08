import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { generateFindings } from '../src/core-open/scoring/drift-score.js';
import { formatSarif } from '../src/core-open/formatters/sarif.js';
import { LICENSE_PARSE_FAILED } from '../src/core-open/licenses/diagnostic.js';
import type { DependencyRow, ProjectScan, ScanArtifact } from '../src/core-open/types.js';

interface FixtureDep {
  package: string;
  raw: string;
  sourcePath?: string;
}

interface FixtureProject {
  name: string;
  path: string;
  dependencies: FixtureDep[];
}

const FIXTURE = fileURLToPath(new URL('./fixtures/license-findings/projects.json', import.meta.url));

function projectsFromFixture(): ProjectScan[] {
  const parsed = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as { projects: FixtureProject[] };
  return parsed.projects.map((project) => {
    const dependencies: DependencyRow[] = project.dependencies.map((dep) => ({
      package: dep.package,
      section: 'dependencies',
      currentSpec: '1.0.0',
      resolvedVersion: '1.0.0',
      latestStable: '1.0.0',
      majorsBehind: 0,
      drift: 'current',
      license: {
        raw: dep.raw,
        spdxId: null,
        source: 'registry',
        confidence: 0,
        ...(dep.sourcePath !== undefined ? { sourcePath: dep.sourcePath } : {}),
      },
    }));
    return {
      type: 'node',
      path: project.path,
      name: project.name,
      runtimeMajorsBehind: 0,
      frameworks: [],
      dependencies,
      dependencyAgeBuckets: { current: dependencies.length, oneBehind: 0, twoPlusBehind: 0, unknown: 0 },
    };
  });
}

function artifact(projects: ProjectScan[]): ScanArtifact {
  const findings = generateFindings(projects);
  return {
    schemaVersion: '1.0',
    timestamp: '2026-10-03T00:00:00.000Z',
    vibgrateVersion: '0.0.0-test',
    rootPath: '.',
    projects,
    drift: {
      score: 0,
      riskLevel: 'low',
      components: { runtimeScore: 0, frameworkScore: 0, dependencyScore: 0, eolScore: 0 },
      measured: [],
    },
    findings,
  };
}

describe('license findings in machine-readable scan output', () => {
  it('includes a stable source path when the fixture recorded one, and still emits a finding when it did not', () => {
    const scan = artifact(projectsFromFixture());
    const again = artifact(projectsFromFixture());
    expect(scan.findings).toEqual(again.findings);

    const licenseFindings = scan.findings.filter((f) => f.ruleId === LICENSE_PARSE_FAILED);
    expect(licenseFindings.map((f) => f.details?.sourcePath ?? null)).toEqual([
      'apps/web/package.json',
      null,
      'package.json',
    ]);
    expect(licenseFindings.map((f) => f.location)).toEqual([
      'apps/web/package.json',
      'apps/api',
      'package.json',
    ]);
    expect(licenseFindings[1]?.details).toEqual({ raw: 'Also-Not-SPDX', warnCode: 'VG_WARN_LICENSE_UNPARSEABLE' });
    expect(JSON.stringify(scan.findings)).not.toContain('beta-ok');

    const json = JSON.stringify(scan, null, 2);
    expect(json).toContain('"sourcePath": "apps/web/package.json"');
    expect(json).toContain('"location": "package.json"');
    expect(json).toContain('"location": "apps/api"');
    expect(json).toBe(JSON.stringify(again, null, 2));

    const sarif = formatSarif(scan) as {
      runs: Array<{
        results: Array<{
          ruleId: string;
          message: { text: string };
          locations: Array<{ physicalLocation: { artifactLocation: { uri: string } } }>;
          properties?: { sourcePath?: string; raw?: string };
        }>;
      }>;
    };
    expect(formatSarif(scan)).toEqual(sarif);
    const results = sarif.runs[0]!.results.filter((r) => r.ruleId === LICENSE_PARSE_FAILED);
    expect(results.map((r) => r.locations[0]?.physicalLocation.artifactLocation.uri)).toEqual([
      'apps/web/package.json',
      'apps/api',
      'package.json',
    ]);
    expect(results[0]?.properties?.sourcePath).toBe('apps/web/package.json');
    expect(results[2]?.properties?.sourcePath).toBe('package.json');
    expect(results[1]?.properties).toEqual({ raw: 'Also-Not-SPDX', warnCode: 'VG_WARN_LICENSE_UNPARSEABLE' });
    expect(results[2]?.locations).toHaveLength(1);
    expect(JSON.stringify(sarif)).not.toContain('beta-ok');
  });
});
