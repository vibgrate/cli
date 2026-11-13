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
