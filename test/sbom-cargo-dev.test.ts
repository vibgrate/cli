/**
 * Cargo `[dev-dependencies]` and `[build-dependencies]` are direct development
 * rows. A crate also declared under `[dependencies]` stays production, and
 * that production declaration supplies the version.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CargoCache } from '../src/core-open/scanners/cargo-cache.js';
import { scanRustProjects } from '../src/core-open/scanners/rust-scanner.js';
import { Semaphore } from '../src/core-open/utils/semaphore.js';
import { collectLockfileGraph, toCycloneDx, toSpdx } from '../src/reporting/commands/sbom.js';
import type { ProjectScan, ScanArtifact } from '../src/reporting/types.js';

const LOCKFILE = `version = 3

[[package]]
name = "app"
version = "0.1.0"

[[package]]
name = "cc"
version = "1.1.0"

[[package]]
name = "criterion"
version = "0.5.1"

[[package]]
name = "only-locked"
version = "3.0.0"

[[package]]
name = "serde"
version = "1.0.210"

[[package]]
name = "shared"
version = "1.2.0"
`;

function manifest(order: 'prod-first' | 'dev-first'): string {
  const prod = `[dependencies]
serde = "1.0.210"
shared = "1.2.0"
`;
  const dev = `[dev-dependencies]
criterion = "0.5.1"
shared = "9.9.9"
missing-dev = "0.4.0"

[build-dependencies]
cc = "1.1.0"
`;
  const tables = order === 'prod-first' ? `${prod}\n${dev}` : `${dev}\n${prod}`;
  return `[package]
name = "app"
version = "0.1.0"
edition = "2021"

${tables}`;
}

function artifact(projects: ProjectScan[]): ScanArtifact {
  return {
    schemaVersion: '1.0',
    timestamp: '2026-02-19T00:00:00.000Z',
    vibgrateVersion: '0.0.1',
    rootPath: 'cargo-dev',
    drift: {
      score: 0,
      riskLevel: 'low',
      components: { runtimeScore: 0, frameworkScore: 0, dependencyScore: 0, eolScore: 0 },
    },
    findings: [],
    projects,
  };
}

class RecordingCargoCache extends CargoCache {
  readonly names: string[] = [];

  override get(crateName: string): ReturnType<CargoCache['get']> {
    this.names.push(crateName);
    return super.get(crateName);
  }
}

describe('sbom export: Cargo dev and build dependencies', () => {
  let root: string;

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function exportOrder(order: 'prod-first' | 'dev-first') {
    const cache = new RecordingCargoCache(new Semaphore(1), undefined, true);
    fs.writeFileSync(path.join(root, 'Cargo.toml'), manifest(order));
    const projects = await scanRustProjects(root, cache);
    const scanArtifact = artifact(projects);
    const graph = collectLockfileGraph(scanArtifact, root);
    return {
      projects,
      lookedUp: cache.names,
      cdx: toCycloneDx(scanArtifact, graph),
      spdx: toSpdx(scanArtifact, graph),
    };
  }

  it('exports criterion and cc as direct development rows and keeps a duplicate production crate', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-cargo-dev-'));
    fs.writeFileSync(path.join(root, 'Cargo.lock'), LOCKFILE);

    const first = await exportOrder('prod-first');
    const second = await exportOrder('dev-first');
    expect(JSON.stringify(second.cdx)).toBe(JSON.stringify(first.cdx));
    expect(JSON.stringify(second.spdx)).toBe(JSON.stringify(first.spdx));
    expect(second.lookedUp.slice().sort()).toEqual(['serde', 'shared']);
    expect(first.lookedUp.slice().sort()).toEqual(['serde', 'shared']);

    const project = first.projects[0]!;
    expect(project.dependencies.map((dep) => [dep.package, dep.section, dep.currentSpec])).toEqual([
      ['cc', 'devDependencies', '1.1.0'],
      ['criterion', 'devDependencies', '0.5.1'],
      ['missing-dev', 'devDependencies', '0.4.0'],
      ['serde', 'dependencies', '1.0.210'],
      ['shared', 'dependencies', '1.2.0'],
    ]);
    expect(project.dependencyAgeBuckets).toEqual({ current: 0, oneBehind: 0, twoPlusBehind: 0, unknown: 2 });
    expect(project.frameworks.map((framework) => framework.name)).toEqual(['Serde']);

    const cdx = first.cdx as {
      components: Array<{ name: string; scope?: string; properties: Array<{ name: string; value: string }> }>;
      dependencies?: unknown;
    };
    const byName = new Map(cdx.components.map((component) => [component.name, component]));
    const vibScope = (name: string): string | undefined =>
      byName.get(name)?.properties.find((property) => property.name === 'vibgrate:scope')?.value;

    expect(byName.get('criterion')?.scope).toBe('excluded');
    expect(byName.get('cc')?.scope).toBe('excluded');
    expect(byName.get('missing-dev')?.scope).toBe('excluded');
    expect(byName.get('serde')?.scope).toBeUndefined();
    expect(byName.get('shared')?.scope).toBeUndefined();
    expect(byName.get('only-locked')?.scope).toBeUndefined();
    expect(vibScope('criterion')).toBe('direct');
    expect(vibScope('cc')).toBe('direct');
    expect(vibScope('missing-dev')).toBe('direct');
    expect(vibScope('serde')).toBe('direct');
    expect(vibScope('shared')).toBe('direct');
    expect(vibScope('only-locked')).toBe('transitive');
    expect(cdx.dependencies).toBeUndefined();

    const spdx = first.spdx as {
      packages: Array<{ name: string }>;
      relationships: Array<{ spdxElementId: string; relatedSpdxElementId: string; relationshipType: string }>;
    };
    const id = (name: string): string => `SPDXRef-Package-${spdx.packages.findIndex((pkg) => pkg.name === name) + 1}`;
    expect(spdx.relationships).toEqual([
      {
        spdxElementId: id('cc'),
        relatedSpdxElementId: 'SPDXRef-DOCUMENT',
        relationshipType: 'DEV_DEPENDENCY_OF',
      },
      {
        spdxElementId: id('criterion'),
        relatedSpdxElementId: 'SPDXRef-DOCUMENT',
        relationshipType: 'DEV_DEPENDENCY_OF',
      },
      {
        spdxElementId: id('missing-dev'),
        relatedSpdxElementId: 'SPDXRef-DOCUMENT',
        relationshipType: 'DEV_DEPENDENCY_OF',
      },
    ]);
    expect(spdx.packages.map((pkg) => pkg.name)).toEqual([
      'app',
      'cc',
      'criterion',
      'missing-dev',
      'only-locked',
      'serde',
      'shared',
    ]);
  });
});
