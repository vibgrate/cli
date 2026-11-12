import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GoCache } from '../src/core-open/scanners/go-cache.js';
import { scanGoProjects } from '../src/core-open/scanners/go-scanner.js';
import type { RuntimeCatalog } from '../src/core-open/runtimes/types.js';
import type { ProjectScan } from '../src/core-open/types.js';
import { Semaphore } from '../src/core-open/utils/semaphore.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/** Newest released cycle is 1.24. Dates stay on the same side of "now". */
const catalog: RuntimeCatalog = {
  generatedAt: '2020-01-01T00:00:00.000Z',
  source: 'endoflife.date',
  products: {
    go: {
      product: 'go',
      cycles: [
        { cycle: '1.9', releaseDate: '2017-08-24', eol: '2001-01-01' },
        { cycle: '1.10', releaseDate: '2018-02-16', eol: '2001-01-01' },
        { cycle: '1.21', releaseDate: '2023-08-08', eol: '2001-01-01' },
        { cycle: '1.22', releaseDate: '2024-02-06', eol: '2001-01-01' },
        { cycle: '1.23', releaseDate: '2024-08-13', eol: '2999-02-01' },
        { cycle: '1.24', releaseDate: '2025-02-11', eol: '2999-08-01' },
      ],
    },
  },
};

function offlineCache(): GoCache {
  return new GoCache(new Semaphore(1), undefined, true);
}

async function scan(goMod: string): Promise<ProjectScan> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-go-toolchain-'));
  roots.push(root);
  fs.writeFileSync(path.join(root, 'go.mod'), goMod);
  const [project] = await scanGoProjects(root, offlineCache(), undefined, undefined, catalog);
  if (!project) throw new Error('expected a Go project');
  return project;
}

function runtimeFacts(project: ProjectScan) {
  return {
    runtime: project.runtime,
    runtimeLatest: project.runtimeLatest,
    runtimeMajorsBehind: project.runtimeMajorsBehind,
    runtimeEol: project.runtimeEol,
    runtimeEolDate: project.runtimeEolDate,
  };
}

describe('go.mod toolchain directive', () => {
  it('uses the go directive when the file has no toolchain line', async () => {
    const goMod = `module example.com/app

go 1.21
`;
    const first = await scan(goMod);
    const second = await scan(goMod);
    expect(runtimeFacts(first)).toEqual(runtimeFacts(second));
    expect(runtimeFacts(first)).toEqual({
      runtime: '1.21',
      runtimeLatest: '1.24',
      runtimeMajorsBehind: 3,
      runtimeEol: true,
      runtimeEolDate: '2001-01-01',
    });
  });

  it('uses a newer toolchain for runtime, lag, and end of life', async () => {
    const newer = await scan(`module example.com/app

go 1.21

toolchain go1.23.4
`);
    expect(runtimeFacts(newer)).toEqual({
      runtime: '1.23',
      runtimeLatest: '1.24',
      runtimeMajorsBehind: 1,
      runtimeEol: false,
      runtimeEolDate: '2999-02-01',
    });

    // 1.10 is a newer minor than 1.9 when the numbers are compared.
    const numeric = await scan(`module example.com/app

go 1.9

toolchain go1.10.0
`);
    expect(runtimeFacts(numeric)).toEqual({
      runtime: '1.10',
      runtimeLatest: '1.24',
      runtimeMajorsBehind: 14,
      runtimeEol: true,
      runtimeEolDate: '2001-01-01',
    });
  });

  it('keeps the go directive when toolchain is default', async () => {
    const project = await scan(`module example.com/app

go 1.21

toolchain default
`);
    expect(runtimeFacts(project)).toEqual({
      runtime: '1.21',
      runtimeLatest: '1.24',
      runtimeMajorsBehind: 3,
      runtimeEol: true,
      runtimeEolDate: '2001-01-01',
    });
  });

  it('keeps the go directive when the toolchain is not newer', async () => {
    const sameMinor = await scan(`module example.com/app

go 1.23

toolchain go1.23.4
`);
    expect(runtimeFacts(sameMinor).runtime).toBe('1.23');
    expect(runtimeFacts(sameMinor)).toMatchObject({
      runtimeLatest: '1.24',
      runtimeMajorsBehind: 1,
      runtimeEol: false,
      runtimeEolDate: '2999-02-01',
    });

    const older = await scan(`module example.com/app

go 1.23

toolchain go1.21.0
`);
    expect(runtimeFacts(older)).toEqual(runtimeFacts(sameMinor));
  });

  it('ignores a malformed toolchain name and a toolchain line inside a block', async () => {
    const project = await scan(`module example.com/app

go 1.21

toolchain go1.23rc1
toolchain go1

require (
	toolchain go1.24.1
	example.com/lib v1.2.3
)
`);
    expect(runtimeFacts(project).runtime).toBe('1.21');
    expect(project.dependencies.map((dep) => dep.package)).toEqual(['example.com/lib']);
  });

  it('uses the toolchain when the file has no go line', async () => {
    const project = await scan(`module example.com/app

toolchain go1.23.4
`);
    expect(runtimeFacts(project)).toEqual({
      runtime: '1.23',
      runtimeLatest: '1.24',
      runtimeMajorsBehind: 1,
      runtimeEol: false,
      runtimeEolDate: '2999-02-01',
    });
  });
});
