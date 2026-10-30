/**
 * Cargo target tables map onto the plain dependency tables.
 * A production declaration wins over a dev, build, or target duplicate.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CargoCache } from '../src/core-open/scanners/cargo-cache.js';
import { scanRustProjects } from '../src/core-open/scanners/rust-scanner.js';
import { Semaphore } from '../src/core-open/utils/semaphore.js';
import type { DependencyRow, ProjectScan } from '../src/core-open/types.js';

class RecordingCargoCache extends CargoCache {
  readonly names: string[] = [];

  override get(crateName: string): ReturnType<CargoCache['get']> {
    this.names.push(crateName);
    return super.get(crateName);
  }
}

const TARGET_FIXTURE = `[package]
name = "app"
version = "0.1.0"
edition = "2021"

[dependencies]
shared = "1.2.0"
serde = "1.0.0"

[dev-dependencies]
shared = "9.9.9"
criterion = { version = "0.5.0", optional = true }

[build-dependencies]
cc = "1.0.0"
shared = "8.8.8"

[profile.release]
lto = true

[workspace.dependencies]
ignored-workspace = "1.0.0"

[target.'cfg(windows)'.dependencies]
winapi = { version = "0.3", features = ["winuser"] }
shared = "7.7.7"

[target.'cfg(unix)'.dependencies]
nix = "0.29"

[target.x86_64-unknown-linux-gnu.dev-dependencies]
pprof = "0.13"

[target."cfg(target_os = \\"macos\\")".dependencies]
core-foundation = "0.9"

[target.'cfg(target_os = "linux")'.build-dependencies]
pkg-config = "0.3"
`;

function row(project: ProjectScan, name: string): DependencyRow {
  const found = project.dependencies.find((dep) => dep.package === name);
  if (!found) throw new Error(`missing ${name}`);
  return found;
}

describe('Cargo.toml target and build tables', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
    roots.length = 0;
  });

  async function scan(toml: string): Promise<{ project: ProjectScan; lookedUp: string[] }> {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-cargo-tables-'));
    roots.push(root);
    fs.writeFileSync(path.join(root, 'Cargo.toml'), toml);
    const cache = new RecordingCargoCache(new Semaphore(1), undefined, true);
    const projects = await scanRustProjects(root, cache);
    return { project: projects[0]!, lookedUp: cache.names };
  }

  it('reads quoted cfg, a bare triple, escaped double quotes, and build tables', async () => {
    const { project, lookedUp } = await scan(TARGET_FIXTURE);

    expect(project.dependencies.map((dep) => [dep.package, dep.section, dep.currentSpec])).toEqual([
      ['cc', 'devDependencies', '1.0.0'],
      ['core-foundation', 'dependencies', '0.9'],
      ['criterion', 'devDependencies', '0.5.0'],
      ['nix', 'dependencies', '0.29'],
      ['pkg-config', 'devDependencies', '0.3'],
      ['pprof', 'devDependencies', '0.13'],
      ['serde', 'dependencies', '1.0.0'],
      ['shared', 'dependencies', '1.2.0'],
      ['winapi', 'dependencies', '0.3'],
    ]);
    expect(row(project, 'winapi').section).toBe('dependencies');
    expect(row(project, 'nix').currentSpec).toBe('0.29');
    expect(row(project, 'pprof').section).toBe('devDependencies');
    expect(row(project, 'criterion').section).toBe('devDependencies');
    expect(project.dependencies.some((dep) => dep.package === 'ignored-workspace')).toBe(false);
    expect(project.dependencyAgeBuckets).toEqual({ current: 0, oneBehind: 0, twoPlusBehind: 0, unknown: 5 });
    expect(lookedUp).toEqual(['shared', 'serde', 'winapi', 'nix', 'core-foundation']);
    expect(project.frameworks.map((framework) => framework.name)).toEqual(['Serde']);
  });

  it('keeps the plain production declaration when a target or dev table repeats the crate', async () => {
    const targetFirst = `[package]
name = "app"
version = "0.1.0"

[target.'cfg(windows)'.dependencies]
winapi = "9.9.9"
shared = "7.7.7"

[dev-dependencies]
shared = "9.9.9"
winapi = "8.8.8"

[dependencies]
winapi = "0.3"
shared = "1.2.0"
`;
    const plainFirst = `[package]
name = "app"
version = "0.1.0"

[dependencies]
winapi = "0.3"
shared = "1.2.0"

[target.'cfg(windows)'.dependencies]
winapi = "9.9.9"
shared = "7.7.7"

[dev-dependencies]
shared = "9.9.9"
winapi = "8.8.8"
`;

    for (const toml of [targetFirst, plainFirst]) {
      const { project } = await scan(toml);
      expect(row(project, 'winapi')).toMatchObject({ section: 'dependencies', currentSpec: '0.3' });
      expect(row(project, 'shared')).toMatchObject({ section: 'dependencies', currentSpec: '1.2.0' });
    }
  });

  it('lets a target production table win over a dev-only duplicate', async () => {
    const devFirst = `[package]
name = "app"
version = "0.1.0"

[dev-dependencies]
nix = "1.0.0"

[target.'cfg(unix)'.dependencies]
nix = "0.29"

[target.'cfg(windows)'.build-dependencies]
cc = "1.2.0"
`;
    const targetFirst = `[package]
name = "app"
version = "0.1.0"

[target.'cfg(unix)'.dependencies]
nix = "0.29"

[target.'cfg(windows)'.build-dependencies]
cc = "1.2.0"

[dev-dependencies]
nix = "1.0.0"
`;

    for (const toml of [devFirst, targetFirst]) {
      const { project, lookedUp } = await scan(toml);
      expect(row(project, 'nix')).toMatchObject({ section: 'dependencies', currentSpec: '0.29' });
      expect(row(project, 'cc')).toMatchObject({ section: 'devDependencies', currentSpec: '1.2.0' });
      expect(lookedUp).toEqual(['nix']);
      expect(project.dependencyAgeBuckets.unknown).toBe(1);
    }
  });

  it('keeps optional = true on a target production crate and on a dev crate', async () => {
    const { project } = await scan(`[package]
name = "app"
version = "0.1.0"

[target.'cfg(windows)'.dependencies]
winapi = { version = "0.3", optional = true }

[dev-dependencies]
criterion = { version = "0.5", optional = true }
`);
    expect(row(project, 'winapi').section).toBe('optionalDependencies');
    expect(row(project, 'criterion').section).toBe('devDependencies');
  });
});
