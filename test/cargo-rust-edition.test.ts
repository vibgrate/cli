/**
 * Cargo.toml package edition. TOML basic ("2021") and literal ('2021')
 * strings are both valid; the scanner must report the same edition and lag
 * for either quote style.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CargoCache } from '../src/core-open/scanners/cargo-cache.js';
import { scanRustProjects } from '../src/core-open/scanners/rust-scanner.js';
import { Semaphore } from '../src/core-open/utils/semaphore.js';
import type { ProjectScan } from '../src/core-open/types.js';

async function scanEdition(editionLine: string): Promise<ProjectScan> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-cargo-edition-'));
  try {
    fs.writeFileSync(
      path.join(root, 'Cargo.toml'),
      `[package]\nname = "app"\nversion = "0.1.0"\n${editionLine}\n`,
    );
    const projects = await scanRustProjects(root, new CargoCache(new Semaphore(1), undefined, true));
    expect(projects).toHaveLength(1);
    return projects[0]!;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function scanEditionTree(files: Record<string, string>): Promise<ProjectScan[]> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-cargo-edition-'));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const manifest = path.join(root, rel, 'Cargo.toml');
      fs.mkdirSync(path.dirname(manifest), { recursive: true });
      fs.writeFileSync(manifest, content);
    }
    return await scanRustProjects(root, new CargoCache(new Semaphore(1), undefined, true));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function projectAt(projects: ProjectScan[], rel: string): ProjectScan {
  const found = projects.find((project) => project.path === rel);
  expect(found, rel).toBeDefined();
  return found!;
}

const WORKSPACE_2021 = '[workspace]\nmembers = ["api"]\n\n[workspace.package]\nedition = "2021"\n';

describe('Cargo package edition', () => {
  it('reads a double-quoted edition', async () => {
    const project = await scanEdition('edition = "2021"');

    expect(project.runtime).toBe('2021');
    expect(project.runtimeLatest).toBe('2024');
    expect(project.runtimeMajorsBehind).toBe(1);
  });

  it('reads a single-quoted edition with the same lag as the double-quoted form', async () => {
    const project = await scanEdition("edition = '2021'");

    expect(project.runtime).toBe('2021');
    expect(project.runtimeLatest).toBe('2024');
    expect(project.runtimeMajorsBehind).toBe(1);
  });

  it('ignores a quoted edition that is not a year of digits', async () => {
    expect((await scanEdition("edition = 'latest'")).runtime).toBeUndefined();
    expect((await scanEdition('edition = "latest"')).runtime).toBeUndefined();
  });
});

describe('Cargo workspace edition inheritance', () => {
  it('inherits the edition with edition.workspace = true', async () => {
    const projects = await scanEditionTree({
      '.': WORKSPACE_2021,
      'api': '[package]\nname = "api"\nversion = "0.1.0"\nedition.workspace = true\n',
    });

    const project = projectAt(projects, 'api');
    expect(project.runtime).toBe('2021');
    expect(project.runtimeLatest).toBe('2024');
    expect(project.runtimeMajorsBehind).toBe(1);
  });

  it('inherits the edition with an inline table', async () => {
    const projects = await scanEditionTree({
      '.': WORKSPACE_2021,
      'api': '[package]\nname = "api"\nversion = "0.1.0"\nedition = {  workspace = true  }\n',
    });

    const project = projectAt(projects, 'api');
    expect(project.runtime).toBe('2021');
    expect(project.runtimeLatest).toBe('2024');
    expect(project.runtimeMajorsBehind).toBe(1);
  });

  it('keeps a member edition over the workspace edition', async () => {
    const projects = await scanEditionTree({
      '.': WORKSPACE_2021,
      'api': '[package]\nname = "api"\nversion = "0.1.0"\nedition = "2024"\n',
    });

    const project = projectAt(projects, 'api');
    expect(project.runtime).toBe('2024');
    expect(project.runtimeMajorsBehind).toBe(0);
  });

  it('leaves the runtime empty when the workspace has no package edition', async () => {
    const projects = await scanEditionTree({
      '.': '[workspace]\nmembers = ["api"]\n',
      'api': '[package]\nname = "api"\nversion = "0.1.0"\nedition.workspace = true\n',
    });

    expect(projectAt(projects, 'api').runtime).toBeUndefined();
  });

  it('reports the edition of a workspace root that is itself a package', async () => {
    const projects = await scanEditionTree({
      '.': '[package]\nname = "root"\nversion = "0.1.0"\nedition = "2021"\n\n[workspace]\nmembers = []\n',
    });

    expect(projectAt(projects, '.').runtime).toBe('2021');
  });
});
