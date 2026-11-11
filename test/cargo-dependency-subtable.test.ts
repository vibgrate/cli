/**
 * Cargo.toml dependency sub-tables (`[dependencies.serde]`,
 * `[dev-dependencies.criterion]`, and the target variants) are the same rows
 * as the inline-table form. Production still beats dev and build, and a
 * non-target table still beats a target table, through the existing dedupe.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CargoCache } from '../src/core-open/scanners/cargo-cache.js';
import { scanRustProjects } from '../src/core-open/scanners/rust-scanner.js';
import { Semaphore } from '../src/core-open/utils/semaphore.js';

const MANIFEST = `[package]
name = "app"
version = "0.1.0"
edition = "2021"

[dependencies.serde]
# version = "9.9.9"
version = "1.0"
features = ["derive"]

[features]
default = []

[dependencies.optional-crate]
version = "2.3.4"
optional = true

[dependencies]
inline-path = { path = "../inline-path" }
inline-git = { git = "https://example.com/inline.git" }
inline-workspace = { workspace = true }
tokio = "1.40.0"

[dependencies.sub-path]
path = "../sub-path"

[dependencies.sub-git]
git = "https://example.com/sub.git"

[dependencies.sub-workspace]
workspace = true

[dependencies.shared]
version = "1.2.3"

[dev-dependencies.shared]
version = "9.9.9"

[dev-dependencies.criterion]
version = "0.5"
features = ["html_reports"]

[build-dependencies.cc]
version = "1.0.97"

[target.'cfg(windows)'.dependencies.winapi]
version = "0.3.9"

[target."cfg(target_os = \\"macos\\")".dependencies.core-foundation]
version = "0.9.4"

[target.'cfg(windows)'.dependencies.tokio]
version = "9.9.9"

[target.'cfg(unix)'.build-dependencies.nix]
version = "0.28.0"

[target.'cfg(unix)'.dev-dependencies.libc]
version = "0.2.155"
`;

describe('Cargo dependency sub-tables', () => {
  let root: string;

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('reads crate sub-tables with the same sections as inline tables', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-cargo-subtable-'));
    fs.writeFileSync(path.join(root, 'Cargo.toml'), MANIFEST);

    const projects = await scanRustProjects(root, new CargoCache(new Semaphore(1), undefined, true));
    const deps = projects[0]!.dependencies;
    const byPackage = new Map(deps.map((dep) => [dep.package, dep]));

    expect(deps.map((dep) => [dep.package, dep.section])).toEqual([
      ['cc', 'devDependencies'],
      ['core-foundation', 'dependencies'],
      ['criterion', 'devDependencies'],
      ['inline-git', 'dependencies'],
      ['inline-path', 'dependencies'],
      ['inline-workspace', 'dependencies'],
      ['libc', 'devDependencies'],
      ['nix', 'devDependencies'],
      ['optional-crate', 'optionalDependencies'],
      ['serde', 'dependencies'],
      ['shared', 'dependencies'],
      ['sub-git', 'dependencies'],
      ['sub-path', 'dependencies'],
      ['sub-workspace', 'dependencies'],
      ['tokio', 'dependencies'],
      ['winapi', 'dependencies'],
    ]);

    expect(byPackage.get('serde')).toMatchObject({ section: 'dependencies', currentSpec: '1.0' });
    expect(byPackage.get('criterion')).toMatchObject({ section: 'devDependencies', currentSpec: '0.5' });
    expect(byPackage.get('optional-crate')).toMatchObject({ section: 'optionalDependencies', currentSpec: '2.3.4' });
    expect(byPackage.get('cc')).toMatchObject({ section: 'devDependencies', currentSpec: '1.0.97' });
    expect(byPackage.get('winapi')).toMatchObject({ section: 'dependencies', currentSpec: '0.3.9' });
    expect(byPackage.get('core-foundation')).toMatchObject({ section: 'dependencies', currentSpec: '0.9.4' });
    expect(byPackage.get('libc')).toMatchObject({ section: 'devDependencies', currentSpec: '0.2.155' });
    expect(byPackage.get('nix')).toMatchObject({ section: 'devDependencies', currentSpec: '0.28.0' });

    expect(byPackage.get('sub-path')).toMatchObject({
      section: byPackage.get('inline-path')!.section,
      currentSpec: byPackage.get('inline-path')!.currentSpec,
    });
    expect(byPackage.get('sub-git')).toMatchObject({
      section: byPackage.get('inline-git')!.section,
      currentSpec: byPackage.get('inline-git')!.currentSpec,
    });
    expect(byPackage.get('sub-workspace')).toMatchObject({
      section: byPackage.get('inline-workspace')!.section,
      currentSpec: byPackage.get('inline-workspace')!.currentSpec,
    });
    expect(byPackage.get('inline-path')!.currentSpec).toBe('*');
    expect(byPackage.get('inline-git')!.currentSpec).toBe('*');
    expect(byPackage.get('inline-workspace')!.currentSpec).toBe('*');

    // Production beats a later dev sub-table. Non-target beats a target sub-table.
    expect(byPackage.get('shared')).toMatchObject({ section: 'dependencies', currentSpec: '1.2.3' });
    expect(byPackage.get('tokio')).toMatchObject({ section: 'dependencies', currentSpec: '1.40.0' });
  });
});
