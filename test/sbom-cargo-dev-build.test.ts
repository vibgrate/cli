/**
 * Cargo dev and build crates are direct development rows. Target tables map
 * to the same sections. A crate also declared as production stays production,
 * and that production declaration supplies the version. Dev and build rows
 * do not change production drift buckets.
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
name = "both-dev"
version = "2.0.0"
source = "registry+https://github.com/rust-lang/crates.io-index"

[[package]]
name = "cc"
version = "1.0.97"
source = "registry+https://github.com/rust-lang/crates.io-index"

[[package]]
name = "core-foundation"
version = "0.9.4"
source = "registry+https://github.com/rust-lang/crates.io-index"

[[package]]
name = "criterion"
version = "0.5.1"
source = "registry+https://github.com/rust-lang/crates.io-index"

[[package]]
name = "libc"
version = "0.2.155"
source = "registry+https://github.com/rust-lang/crates.io-index"

[[package]]
name = "lockfile-only"
version = "9.9.9"
source = "registry+https://github.com/rust-lang/crates.io-index"

[[package]]
name = "nix"
version = "0.28.0"
source = "registry+https://github.com/rust-lang/crates.io-index"

[[package]]
name = "optional-crate"
version = "2.3.4"
source = "registry+https://github.com/rust-lang/crates.io-index"

[[package]]
name = "serde"
version = "1.0.203"
source = "registry+https://github.com/rust-lang/crates.io-index"

[[package]]
name = "shared"
version = "1.2.3"
source = "registry+https://github.com/rust-lang/crates.io-index"

[[package]]
name = "target-optional"
version = "1.5.0"
source = "registry+https://github.com/rust-lang/crates.io-index"

[[package]]
name = "tokio"
version = "1.40.0"
source = "registry+https://github.com/rust-lang/crates.io-index"

[[package]]
name = "winapi"
version = "0.3.9"
source = "registry+https://github.com/rust-lang/crates.io-index"

[[package]]
name = "windows-sys"
version = "0.52.0"
source = "registry+https://github.com/rust-lang/crates.io-index"
`;

const DEPS = `[dependencies]
serde = "1.0.203"
optional-crate = { version = "2.3.4", optional = true }
shared = "1.2.3"
`;

const DEV = `[dev-dependencies]
criterion = { version = "0.5.1", optional = true }
serde = "0.1.0"
optional-crate = "9.9.9"
both-dev = "2.0.0"
dev-only-missing = "0.4.0"
`;

const BUILD = `[build-dependencies]
cc = "1.0.97"
both-dev = "3.0.0"
`;

const TARGET_WINDOWS = `[target.'cfg(windows)'.dependencies]
winapi = "0.3.9"
serde = "9.9.9"
tokio = "1.40.0"
`;

const TARGET_MAC = `[target."cfg(target_os = \\"macos\\")".dependencies]
core-foundation = "0.9.4"
`;

const TARGET_MSVC = `[target.x86_64-pc-windows-msvc.dependencies]
windows-sys = "0.52.0"
`;

const TARGET_UNIX_DEV = `[target.'cfg(unix)'.dev-dependencies]
libc = "0.2.155"
`;

const TARGET_UNIX_BUILD = `[target.'cfg(unix)'.build-dependencies]
nix = "0.28.0"
cc = "1.2.0"
`;

const TARGET_UNIX_PROD = `[target.'cfg(unix)'.dependencies]
shared = "8.8.8"
target-optional = { version = "1.5.0", optional = true }
`;

function manifest(order: 'deps-first' | 'dev-first'): string {
  const head = `[package]
name = "app"
version = "0.1.0"
edition = "2021"
`;
  const blocks = order === 'deps-first'
    ? [DEPS, DEV, BUILD, TARGET_WINDOWS, TARGET_MAC, TARGET_MSVC, TARGET_UNIX_DEV, TARGET_UNIX_BUILD, TARGET_UNIX_PROD]
    : [TARGET_UNIX_PROD, TARGET_UNIX_BUILD, TARGET_UNIX_DEV, TARGET_MSVC, TARGET_MAC, TARGET_WINDOWS, BUILD, DEV, DEPS];
  return [head, ...blocks].join('\n');
}

function artifact(projects: ProjectScan[]): ScanArtifact {
  return {
    schemaVersion: '1.0',
    timestamp: '2026-02-19T00:00:00.000Z',
    vibgrateVersion: '0.0.1',
    rootPath: 'cargo-dev-build',
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

type Cdx = {
  components: Array<{ name: string; scope?: string; properties: Array<{ name: string; value: string }> }>;
  dependencies?: unknown;
};

type Spdx = {
  packages: Array<{ name: string }>;
  relationships: Array<{ spdxElementId: string; relatedSpdxElementId: string; relationshipType: string }>;
};

function vibScope(cdx: Cdx, name: string): string | undefined {
  const component = cdx.components.find((row) => row.name === name);
  return component?.properties.find((property) => property.name === 'vibgrate:scope')?.value;
}

function relNames(spdx: Spdx, kind: string): string[] {
  return spdx.relationships
    .filter((rel) => rel.relationshipType === kind)
    .map((rel) => spdx.packages[Number(rel.spdxElementId.replace('SPDXRef-Package-', '')) - 1]!.name);
}

describe('sbom export: Cargo dev and build dependencies', () => {
  let root: string;

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function exportOrder(order: 'deps-first' | 'dev-first') {
    fs.writeFileSync(path.join(root, 'Cargo.toml'), manifest(order));
    const projects = await scan(root);
    const scanArtifact = artifact(projects);
    const graph = collectLockfileGraph(scanArtifact, root);
    return {
      projects,
      cdx: toCycloneDx(scanArtifact, graph) as Cdx,
      spdx: toSpdx(scanArtifact, graph) as Spdx,
    };
  }

  it('exports dev, build, and target crates, and keeps one production row', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-cargo-dev-build-'));
    fs.writeFileSync(path.join(root, 'Cargo.lock'), LOCKFILE);

    const first = await exportOrder('deps-first');
    const second = await exportOrder('dev-first');
    expect(JSON.stringify(second.cdx)).toBe(JSON.stringify(first.cdx));
    expect(JSON.stringify(second.spdx)).toBe(JSON.stringify(first.spdx));
    expect(second.projects[0]!.dependencies).toEqual(first.projects[0]!.dependencies);
    expect(second.projects[0]!.dependencyAgeBuckets).toEqual(first.projects[0]!.dependencyAgeBuckets);

    const project = first.projects[0]!;
    const byPackage = new Map(project.dependencies.map((dep) => [dep.package, dep]));
    expect(byPackage.get('serde')).toMatchObject({ section: 'dependencies', currentSpec: '1.0.203', resolvedVersion: '1.0.203' });
    expect(byPackage.get('optional-crate')).toMatchObject({ section: 'optionalDependencies', currentSpec: '2.3.4' });
    expect(byPackage.get('shared')).toMatchObject({ section: 'dependencies', currentSpec: '1.2.3' });
    expect(byPackage.get('winapi')).toMatchObject({ section: 'dependencies', currentSpec: '0.3.9' });
    expect(byPackage.get('tokio')).toMatchObject({ section: 'dependencies', currentSpec: '1.40.0' });
    expect(byPackage.get('core-foundation')).toMatchObject({ section: 'dependencies', currentSpec: '0.9.4' });
    expect(byPackage.get('windows-sys')).toMatchObject({ section: 'dependencies', currentSpec: '0.52.0' });
    expect(byPackage.get('target-optional')).toMatchObject({ section: 'optionalDependencies', currentSpec: '1.5.0' });
    expect(byPackage.get('criterion')).toMatchObject({ section: 'devDependencies', currentSpec: '0.5.1' });
    expect(byPackage.get('cc')).toMatchObject({ section: 'devDependencies', currentSpec: '1.0.97' });
    expect(byPackage.get('both-dev')).toMatchObject({ section: 'devDependencies', currentSpec: '2.0.0' });
    expect(byPackage.get('libc')).toMatchObject({ section: 'devDependencies', currentSpec: '0.2.155' });
    expect(byPackage.get('nix')).toMatchObject({ section: 'devDependencies', currentSpec: '0.28.0' });
    expect(byPackage.get('dev-only-missing')).toMatchObject({
      section: 'devDependencies',
      currentSpec: '0.4.0',
      resolvedVersion: '0.4.0',
    });
    expect(byPackage.size).toBe(14);
    expect(project.dependencyAgeBuckets).toEqual({ current: 0, oneBehind: 0, twoPlusBehind: 0, unknown: 8 });
    expect(project.frameworks.map((framework) => framework.name).sort()).toEqual(['Serde', 'Tokio']);

    const dev = ['both-dev', 'cc', 'criterion', 'dev-only-missing', 'libc', 'nix'];
    const optional = ['optional-crate', 'target-optional'];
    const production = ['core-foundation', 'serde', 'shared', 'tokio', 'winapi', 'windows-sys'];
    for (const name of dev) {
      expect(vibScope(first.cdx, name)).toBe('direct');
      expect(first.cdx.components.find((row) => row.name === name)?.scope).toBe('excluded');
    }
    for (const name of optional) {
      expect(vibScope(first.cdx, name)).toBe('direct');
      expect(first.cdx.components.find((row) => row.name === name)?.scope).toBe('optional');
    }
    for (const name of production) {
      expect(vibScope(first.cdx, name)).toBe('direct');
      expect(first.cdx.components.find((row) => row.name === name)?.scope).toBeUndefined();
    }
    expect(vibScope(first.cdx, 'lockfile-only')).toBe('transitive');
    expect(first.cdx.components.find((row) => row.name === 'lockfile-only')?.scope).toBeUndefined();
    // The root crate ("app") has no `source` in Cargo.lock, so it is the
    // scanned project, not a crates.io component, and is left out (see #512).
    expect(first.cdx.components.some((row) => row.name === 'app')).toBe(false);
    expect(first.spdx.packages.some((pkg) => pkg.name === 'app')).toBe(false);
    expect(first.cdx.components.some((row) => row.name === 'dev-only-missing')).toBe(true);
    expect(first.cdx.dependencies).toBeUndefined();

    expect(relNames(first.spdx, 'DEV_DEPENDENCY_OF').sort()).toEqual(dev);
    expect(relNames(first.spdx, 'OPTIONAL_DEPENDENCY_OF').sort()).toEqual(optional);
    expect(first.spdx.relationships.some((rel) => rel.relationshipType === 'DEPENDS_ON')).toBe(false);
    expect(first.spdx.relationships.some((rel) => rel.relationshipType === 'BUILD_DEPENDENCY_OF')).toBe(false);
    expect(first.spdx.relationships.every((rel) => rel.relatedSpdxElementId === 'SPDXRef-DOCUMENT')).toBe(true);
  });
});
