import { describe, it, expect } from 'vitest';
import { scanToolingInventory } from './tooling-inventory.js';
import type { ProjectScan, DependencyRow } from '../../core-open/index.js';

function makeDep(pkg: string, version: string | null = '1.0.0'): DependencyRow {
  return {
    package: pkg,
    section: 'dependencies',
    currentSpec: version ? `^${version}` : '*',
    resolvedVersion: version,
    latestStable: version,
    majorsBehind: 0,
    drift: 'current',
  };
}

function makeProject(deps: DependencyRow[], name = 'test-project'): ProjectScan {
  return {
    type: 'node',
    path: '.',
    name,
    frameworks: [],
    dependencies: deps,
    dependencyAgeBuckets: { current: 0, oneBehind: 0, twoPlusBehind: 0, unknown: 0 },
  };
}

describe('scanToolingInventory', () => {
  it('returns empty categories for empty project list', () => {
    const result = scanToolingInventory([]);
    expect(result.frontend).toEqual([]);
    expect(result.backend).toEqual([]);
    expect(result.testing).toEqual([]);
    expect(result.bundlers).toEqual([]);
    expect(result.orm).toEqual([]);
    expect(result.observability).toEqual([]);
  });

  it('detects frontend frameworks', () => {
    const result = scanToolingInventory([
      makeProject([makeDep('react', '18.2.0'), makeDep('vue', '3.4.0')]),
    ]);
    expect(result.frontend).toHaveLength(2);
    expect(result.frontend.find((i) => i.package === 'react')?.name).toBe('React');
    expect(result.frontend.find((i) => i.package === 'vue')?.name).toBe('Vue');
  });

  it('detects Angular as frontend framework', () => {
    const result = scanToolingInventory([
      makeProject([makeDep('@angular/core', '17.0.0')]),
    ]);
    expect(result.frontend).toHaveLength(1);
    expect(result.frontend[0]!.name).toBe('Angular');
    expect(result.frontend[0]!.version).toBe('17.0.0');
  });

  it('detects meta-frameworks', () => {
    const result = scanToolingInventory([
      makeProject([makeDep('next', '14.1.0'), makeDep('nuxt', '3.9.0')]),
    ]);
    expect(result.metaFrameworks).toHaveLength(2);
    expect(result.metaFrameworks.find((i) => i.package === 'next')?.name).toBe('Next.js');
    expect(result.metaFrameworks.find((i) => i.package === 'nuxt')?.name).toBe('Nuxt');
  });

  it('detects bundlers', () => {
    const result = scanToolingInventory([
      makeProject([makeDep('vite', '5.1.0'), makeDep('webpack', '5.90.0')]),
    ]);
    expect(result.bundlers).toHaveLength(2);
    expect(result.bundlers.find((i) => i.package === 'vite')?.name).toBe('Vite');
    expect(result.bundlers.find((i) => i.package === 'webpack')?.name).toBe('webpack');
  });

  it('detects CSS frameworks and libraries', () => {
    const result = scanToolingInventory([
      makeProject([makeDep('tailwindcss', '3.4.0'), makeDep('@emotion/react', '11.11.0')]),
    ]);
    expect(result.css).toHaveLength(2);
    expect(result.css.find((i) => i.package === 'tailwindcss')?.name).toBe('Tailwind CSS');
  });

  it('detects backend frameworks', () => {
    const result = scanToolingInventory([
      makeProject([makeDep('express', '4.18.0'), makeDep('fastify', '4.25.0')]),
    ]);
    expect(result.backend).toHaveLength(2);
    expect(result.backend.find((i) => i.package === 'express')?.name).toBe('Express');
    expect(result.backend.find((i) => i.package === 'fastify')?.name).toBe('Fastify');
  });

  it('detects NestJS as backend framework', () => {
    const result = scanToolingInventory([
      makeProject([makeDep('@nestjs/core', '10.3.0')]),
    ]);
    expect(result.backend).toHaveLength(1);
    expect(result.backend[0]!.name).toBe('NestJS');
  });

  it('detects ORM and database clients', () => {
    const result = scanToolingInventory([
      makeProject([
        makeDep('prisma', '5.8.0'),
        makeDep('pg', '8.11.0'),
        makeDep('ioredis', '5.3.0'),
      ]),
    ]);
    expect(result.orm).toHaveLength(3);
    expect(result.orm.find((i) => i.package === 'prisma')?.name).toBe('Prisma');
    expect(result.orm.find((i) => i.package === 'pg')?.name).toBe('pg (PostgreSQL)');
  });

  it('detects testing frameworks', () => {
    const result = scanToolingInventory([
      makeProject([
        makeDep('vitest', '1.3.0'),
        makeDep('jest', '29.7.0'),
        makeDep('@playwright/test', '1.41.0'),
      ]),
    ]);
    expect(result.testing).toHaveLength(3);
    expect(result.testing.find((i) => i.package === 'vitest')?.name).toBe('Vitest');
    expect(result.testing.find((i) => i.package === '@playwright/test')?.name).toBe('Playwright');
  });

  it('detects linting and formatting tools', () => {
    const result = scanToolingInventory([
      makeProject([makeDep('eslint', '8.56.0'), makeDep('prettier', '3.2.0')]),
    ]);
    expect(result.lintFormat).toHaveLength(2);
    expect(result.lintFormat.find((i) => i.package === 'eslint')?.name).toBe('ESLint');
    expect(result.lintFormat.find((i) => i.package === 'prettier')?.name).toBe('Prettier');
  });

  it('detects Biome as lint/format tool', () => {
    const result = scanToolingInventory([
      makeProject([makeDep('@biomejs/biome', '1.5.0')]),
    ]);
    expect(result.lintFormat).toHaveLength(1);
    expect(result.lintFormat[0]!.name).toBe('Biome');
  });

  it('detects API and messaging libraries', () => {
    const result = scanToolingInventory([
      makeProject([makeDep('graphql', '16.8.0'), makeDep('@trpc/server', '10.45.0')]),
    ]);
    expect(result.apiMessaging).toHaveLength(2);
    expect(result.apiMessaging.find((i) => i.package === 'graphql')?.name).toBe('GraphQL');
  });

  it('detects observability tools', () => {
    const result = scanToolingInventory([
      makeProject([
        makeDep('@sentry/node', '7.91.0'),
        makeDep('pino', '8.18.0'),
      ]),
    ]);
    expect(result.observability).toHaveLength(2);
    expect(result.observability.find((i) => i.package === '@sentry/node')?.name).toBe('Sentry (Node)');
    expect(result.observability.find((i) => i.package === 'pino')?.name).toBe('Pino');
  });

  it('collects inventory across multiple projects', () => {
    const result = scanToolingInventory([
      makeProject([makeDep('react', '18.2.0')], 'app'),
      makeProject([makeDep('express', '4.18.0')], 'api'),
    ]);
    expect(result.frontend).toHaveLength(1);
    expect(result.backend).toHaveLength(1);
  });

  it('deduplicates packages across projects (uses first version found)', () => {
    const result = scanToolingInventory([
      makeProject([makeDep('react', '18.2.0')], 'app1'),
      makeProject([makeDep('react', '17.0.0')], 'app2'),
    ]);
    expect(result.frontend).toHaveLength(1);
    expect(result.frontend[0]!.version).toBe('18.2.0');
  });

  it('handles packages with null resolved version', () => {
    const result = scanToolingInventory([
      makeProject([makeDep('react', null)]),
    ]);
    expect(result.frontend).toHaveLength(1);
    expect(result.frontend[0]!.version).toBeNull();
  });

  it('ignores packages not in any category', () => {
    const result = scanToolingInventory([
      makeProject([makeDep('some-random-package', '1.0.0')]),
    ]);
    for (const category of Object.values(result)) {
      expect(category).toEqual([]);
    }
  });

  it('sorts items alphabetically within each category', () => {
    const result = scanToolingInventory([
      makeProject([
        makeDep('winston', '3.11.0'),
        makeDep('pino', '8.18.0'),
        makeDep('@sentry/node', '7.91.0'),
      ]),
    ]);
    const names = result.observability.map((i) => i.name);
    expect(names).toEqual([...names].sort());
  });
});
