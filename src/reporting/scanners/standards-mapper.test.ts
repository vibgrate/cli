import { describe, it, expect } from 'vitest';
import { inferProjectPurpose, recommendStandards } from './standards-mapper.js';
import type { ProjectScan } from '../../core-open/index.js';

function project(partial: Partial<ProjectScan>): ProjectScan {
  return {
    type: 'node',
    path: '.',
    name: 'svc',
    frameworks: [],
    dependencies: [],
    dependencyAgeBuckets: { current: 0, oneBehind: 0, twoPlusBehind: 0, unknown: 0 },
    ...partial,
  } as ProjectScan;
}

describe('inferProjectPurpose', () => {
  it('classifies a Next.js project as web-app', () => {
    const p = project({ architecture: { archetype: 'nextjs' } as ProjectScan['architecture'] });
    const purpose = inferProjectPurpose(p);
    expect(purpose.category).toBe('web-app');
    expect(purpose.confidence).toBeGreaterThan(0.4);
    expect(purpose.signals).toContain('archetype:nextjs');
  });

  it('classifies an Express service as api', () => {
    const p = project({ architecture: { archetype: 'express' } as ProjectScan['architecture'] });
    expect(inferProjectPurpose(p).category).toBe('api');
  });

  it('classifies infra tooling (terraform deps) as infra', () => {
    const p = project({
      name: 'infra',
      dependencies: [
        {
          package: 'cdktf',
          section: 'dependencies',
          currentSpec: '0.20.0',
          resolvedVersion: '0.20.0',
          latestStable: null,
          majorsBehind: null,
          drift: 'unknown',
        } as ProjectScan['dependencies'][number],
      ],
    });
    expect(inferProjectPurpose(p).category).toBe('infra');
  });

  it('falls back to "any" with low confidence when there is no signal', () => {
    const purpose = inferProjectPurpose(project({}));
    expect(purpose.category).toBe('any');
    expect(purpose.confidence).toBeLessThan(0.5);
  });

  // Framework detection must work across every supported language, not just JS.
  const fw = (name: string): ProjectScan['frameworks'][number] =>
    ({ name, currentVersion: '1.0.0', latestVersion: null, majorsBehind: null }) as ProjectScan['frameworks'][number];

  it.each([
    ['java', 'Spring Boot', 'api'],
    ['java', 'Quarkus', 'api'],
    ['kotlin', 'Ktor', 'api'],
    ['scala', 'Akka HTTP', 'api'],
    ['python', 'Django', 'api'],
    ['python', 'FastAPI', 'api'],
    ['go', 'Gin', 'api'],
    ['go', 'Echo', 'api'],
    ['rust', 'Actix', 'api'],
    ['ruby', 'Ruby on Rails', 'api'],
    ['php', 'Laravel', 'api'],
    ['dotnet', 'ASP.NET Core', 'api'],
    ['elixir', 'Phoenix', 'api'],
    ['dotnet', 'Blazor', 'web-app'],
    ['java', 'Vaadin', 'web-app'],
  ] as const)('classifies a %s %s project as %s', (type, frameworkName, expected) => {
    const p = project({ type: type as ProjectScan['type'], frameworks: [fw(frameworkName)] });
    expect(inferProjectPurpose(p).category).toBe(expected);
  });
});

describe('recommendStandards', () => {
  it('recommends standards and reports framework coverage for an API repo', () => {
    const p = project({ name: 'api', architecture: { archetype: 'express' } as ProjectScan['architecture'] });
    const result = recommendStandards([p]);
    expect(result.projectPurposes[0].category).toBe('api');
    expect(result.recommended.length).toBeGreaterThan(0);
    // compliance-relevant standards rank first
    expect(result.recommended[0].complianceRelevant).toBe(true);
    // SOC 2 / OWASP-style frameworks should have at least one recommended member
    expect(result.frameworks.length).toBeGreaterThan(0);
    expect(result.frameworks.every((f) => f.recommendedMembers > 0 && f.recommendedMembers <= f.totalMembers)).toBe(true);
  });

  it('respects the total limit and dedupes across projects', () => {
    const projects = [
      project({ name: 'web', architecture: { archetype: 'nextjs' } as ProjectScan['architecture'] }),
      project({ name: 'api', architecture: { archetype: 'nestjs' } as ProjectScan['architecture'] }),
    ];
    const result = recommendStandards(projects, undefined, { totalLimit: 15 });
    expect(result.recommended.length).toBeLessThanOrEqual(15);
    const slugs = result.recommended.map((r) => r.slug);
    expect(new Set(slugs).size).toBe(slugs.length); // no duplicates
  });
});
