/**
 * Cargo workspace inheritance. A member `name = { workspace = true }` with no
 * local `version` uses the workspace root `[workspace.dependencies]` pin.
 * The root is the nearest Cargo.toml that has a `[workspace]` table, inside
 * the scan root. A local `version` wins. `features` and `optional` are copied
 * from the pin only when the member does not set them. Path-only and git-only
 * tables stay spec `*`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CargoCache } from '../src/core-open/scanners/cargo-cache.js';
import {
  parseCargoDepAttrs,
  parseWorkspaceDependencies,
  scanRustProjects,
} from '../src/core-open/scanners/rust-scanner.js';
import { Semaphore } from '../src/core-open/utils/semaphore.js';
import type { ProjectScan } from '../src/core-open/types.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/cargo-workspace-member/', import.meta.url));

const MEMBER_ROWS: Array<[string, string, string]> = [
  ['anyhow', 'dependencies', '1.0.86'],
  ['cc', 'devDependencies', '1.0.97'],
  ['criterion', 'devDependencies', '0.5.1'],
  ['git-dep', 'dependencies', '*'],
  ['git-only', 'dependencies', '*'],
  ['local-pin', 'optionalDependencies', '2.0'],
  ['missing', 'dependencies', '*'],
  ['path-dep', 'dependencies', '*'],
  ['path-only', 'dependencies', '*'],
  ['regex', 'optionalDependencies', '1.10'],
  ['serde', 'dependencies', '1.0'],
  ['serde_json', 'dependencies', '1.0.108'],
  ['shared-git', 'dependencies', '*'],
  ['shared-path', 'dependencies', '*'],
  ['tokio', 'dependencies', '1.35'],
  ['winapi', 'dependencies', '0.3.9'],
];

function projectAt(projects: ProjectScan[], rel: string): ProjectScan {
  const found = projects.find((project) => project.path === rel);
  expect(found, rel).toBeDefined();
  return found!;
}

function specRows(project: ProjectScan): Array<[string, string, string]> {
  return project.dependencies
    .map((dep): [string, string, string] => [dep.package, dep.section, dep.currentSpec])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

describe('parseCargoDepAttrs workspace inheritance', () => {
  const pin = { version: '1.35', features: ['full', 'macros'], optional: true };

  it('uses the workspace pin when the local table only sets workspace = true', () => {
    expect(parseCargoDepAttrs('workspace = true', pin)).toEqual({
      version: '1.35',
      optional: true,
      features: ['full', 'macros'],
    });
    expect(parseCargoDepAttrs('workspace = true', { version: '1.0' })).toEqual({
      version: '1.0',
      optional: false,
      features: [],
    });
  });

  it('keeps a local version, features list, and optional flag over the pin', () => {
    expect(parseCargoDepAttrs('workspace = true, version = "2.0"', pin)).toEqual({
      version: '2.0',
      optional: true,
      features: ['full', 'macros'],
    });
    expect(parseCargoDepAttrs('workspace = true, optional = false, features = ["rt"]', pin)).toEqual({
      version: '1.35',
      optional: false,
      features: ['rt'],
    });
    expect(parseCargoDepAttrs('workspace = true, features = []', pin)).toEqual({
      version: '1.35',
      optional: true,
      features: [],
    });
    expect(parseCargoDepAttrs('workspace = true\nfeatures = ["std"]\n', {
      version: '1.0.108',
      features: ['raw_value'],
      optional: true,
    })).toEqual({
      version: '1.0.108',
      optional: true,
      features: ['std'],
    });
  });

  it('does not invent a version for path-only or git-only tables', () => {
    expect(parseCargoDepAttrs('path = "../x"', pin)).toEqual({
      version: '*',
      optional: false,
      features: [],
    });
    expect(parseCargoDepAttrs('git = "https://example.com/x.git"', pin)).toEqual({
      version: '*',
      optional: false,
      features: [],
    });
    expect(parseCargoDepAttrs('git = "https://example.com/workspace = true.git"', pin)).toEqual({
      version: '*',
      optional: false,
      features: [],
    });
    expect(parseCargoDepAttrs('workspace = true', {})).toEqual({
      version: '*',
      optional: false,
      features: [],
    });
    expect(parseCargoDepAttrs('workspace = true', null)).toEqual({
      version: '*',
      optional: false,
      features: [],
    });
  });

  it('ignores workspace = true in a comment or when the flag is false', () => {
    expect(parseCargoDepAttrs('version = "3.1", features = ["keep"] # workspace = true', pin)).toEqual({
      version: '3.1',
      optional: false,
      features: ['keep'],
    });
    expect(parseCargoDepAttrs('workspace = false, version = "1.2"', pin)).toEqual({
      version: '1.2',
      optional: false,
      features: [],
    });
  });
});

describe('Cargo workspace member fixture', () => {
  it('reads string and table pins from the workspace root', () => {
    const pins = parseWorkspaceDependencies(fs.readFileSync(path.join(FIXTURE, 'Cargo.toml'), 'utf8'));
    expect(pins.get('serde')).toEqual({ version: '1.0' });
    expect(pins.get('tokio')).toEqual({ version: '1.35', features: ['full'], optional: true });
    expect(pins.get('anyhow')).toEqual({ version: '1.0.86', features: ['backtrace'] });
    expect(pins.get('regex')).toEqual({ version: '1.10', features: ['unicode'], optional: true });
    expect(pins.get('local-pin')).toEqual({ version: '0.9', features: ['extra'], optional: false });
    expect(pins.get('path-only')).toEqual({});
    expect(pins.get('git-only')).toEqual({});
    expect(pins.get('serde_json')).toEqual({ version: '1.0.108', features: ['raw_value'] });
    expect(pins.get('cc')).toEqual({ version: '1.0.97' });
    expect(parseCargoDepAttrs('workspace = true', pins.get('serde_json'))).toEqual({
      version: '1.0.108',
      optional: false,
      features: ['raw_value'],
    });
  });

  it('inherits pins for a member and leaves path and git tables unset', async () => {
    const projects = await scanRustProjects(FIXTURE, new CargoCache(new Semaphore(1), undefined, true));
    expect(specRows(projectAt(projects, 'crates/app'))).toEqual(MEMBER_ROWS);
    expect(projectAt(projects, '.').dependencies).toEqual([]);
    expect(projectAt(projects, 'nested').dependencies).toEqual([]);
    expect(specRows(projectAt(projects, path.join('nested', 'crates', 'app')))).toEqual([
      ['serde', 'dependencies', '1.2.3'],
    ]);
    expect(specRows(projectAt(projects, 'self-workspace'))).toEqual([
      ['path-dep', 'dependencies', '*'],
      ['serde', 'dependencies', '1.4.0'],
    ]);
  });
});
