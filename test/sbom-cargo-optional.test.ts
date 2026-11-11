/**
 * Cargo `[dependencies] optional = true` is an optional manifest row.
 * `[dev-dependencies]` stays off that mark, including when the entry also
 * sets `optional = true`. That crate is a direct development row.
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
name = "dev-optional-crate"
version = "0.5.0"
source = "registry+https://github.com/rust-lang/crates.io-index"

[[package]]
name = "optional-crate"
version = "2.3.4"
source = "registry+https://github.com/rust-lang/crates.io-index"

[[package]]
name = "required-crate"
version = "1.2.3"
source = "registry+https://github.com/rust-lang/crates.io-index"
`;

function manifest(order: 'required-first' | 'optional-first'): string {
  const required = 'required-crate = "1.2.3"';
  const optional = 'optional-crate = { version = "2.3.4", optional = true }';
  const deps = order === 'required-first' ? `${required}\n${optional}` : `${optional}\n${required}`;
  return `[package]
name = "app"
version = "0.1.0"
edition = "2021"

[dependencies]
${deps}

[dev-dependencies]
dev-optional-crate = { version = "0.5.0", optional = true }
`;
}

function artifact(projects: ProjectScan[]): ScanArtifact {
  return {
    schemaVersion: '1.0',
    timestamp: '2026-02-19T00:00:00.000Z',
    vibgrateVersion: '0.0.1',
    rootPath: 'cargo-optional',
    drift: {
      score: 0,
      riskLevel: 'low',
      components: { runtimeScore: 0, frameworkScore: 0, dependencyScore: 0, eolScore: 0 },
    },
    findings: [],
    projects,
  };
}

async function scan(root: string): Promise<ProjectScan[]> {
  return scanRustProjects(root, new CargoCache(new Semaphore(1), undefined, true));
}

describe('sbom export: Cargo optional dependencies', () => {
  let root: string;

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function exportOrder(order: 'required-first' | 'optional-first') {
    fs.writeFileSync(path.join(root, 'Cargo.toml'), manifest(order));
    const projects = await scan(root);
    const scanArtifact = artifact(projects);
    const graph = collectLockfileGraph(scanArtifact, root);
    return {
      projects,
      cdx: toCycloneDx(scanArtifact, graph),
      spdx: toSpdx(scanArtifact, graph),
    };
  }

  it('marks the optional crate and leaves the required crate unmarked, independent of Cargo.toml order', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-cargo-optional-'));
    fs.writeFileSync(path.join(root, 'Cargo.lock'), LOCKFILE);

    const first = await exportOrder('required-first');
    const second = await exportOrder('optional-first');
    expect(JSON.stringify(second.cdx)).toBe(JSON.stringify(first.cdx));
    expect(JSON.stringify(second.spdx)).toBe(JSON.stringify(first.spdx));

    const project = first.projects[0]!;
    expect(project.dependencies.map((dep) => [dep.package, dep.section])).toEqual([
      ['dev-optional-crate', 'devDependencies'],
      ['optional-crate', 'optionalDependencies'],
      ['required-crate', 'dependencies'],
    ]);
    expect(project.dependencyAgeBuckets).toEqual({ current: 0, oneBehind: 0, twoPlusBehind: 0, unknown: 2 });

    const cdx = first.cdx as {
      components: Array<{ name: string; scope?: string; properties: Array<{ name: string; value: string }> }>;
      dependencies?: unknown;
    };
    const byName = new Map(cdx.components.map((component) => [component.name, component]));
    const vibScope = (name: string): string | undefined =>
      byName.get(name)?.properties.find((property) => property.name === 'vibgrate:scope')?.value;

    expect(byName.get('optional-crate')?.scope).toBe('optional');
    expect(byName.get('required-crate')?.scope).toBeUndefined();
    expect(byName.get('dev-optional-crate')?.scope).toBe('excluded');
    expect(vibScope('optional-crate')).toBe('direct');
    expect(vibScope('required-crate')).toBe('direct');
    expect(vibScope('dev-optional-crate')).toBe('direct');
    expect(cdx.dependencies).toBeUndefined();

    const spdx = first.spdx as {
      packages: Array<{ name: string }>;
      relationships: Array<{ spdxElementId: string; relatedSpdxElementId: string; relationshipType: string }>;
    };
    const id = (name: string): string => `SPDXRef-Package-${spdx.packages.findIndex((pkg) => pkg.name === name) + 1}`;
    expect(spdx.relationships).toEqual([
      {
        spdxElementId: id('dev-optional-crate'),
        relatedSpdxElementId: 'SPDXRef-DOCUMENT',
        relationshipType: 'DEV_DEPENDENCY_OF',
      },
      {
        spdxElementId: id('optional-crate'),
        relatedSpdxElementId: 'SPDXRef-DOCUMENT',
        relationshipType: 'OPTIONAL_DEPENDENCY_OF',
      },
    ]);
    // The root crate ("app") has no `source` in Cargo.lock and is dropped
    // from the SBOM; only registry crates are components (see #512).
    expect(spdx.packages.map((pkg) => pkg.name)).toEqual(['dev-optional-crate', 'optional-crate', 'required-crate']);
  });
});
