import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { scanFileHotspots, computePackageCentrality } from './file-hotspots.js';
import type { ProjectScan, DependencyRow } from '../../core-open/index.js';

async function createTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(tmpdir(), 'vibgrate-hotspot-test-'));
}

function makeDep(pkg: string): DependencyRow {
  return {
    package: pkg,
    currentSpec: '^1.0.0',
    resolvedVersion: '1.0.0',
    latestStable: '1.0.0',
    majorsBehind: 0,
    drift: 'current',
    section: 'dependencies',
  };
}

function makeProject(name: string, deps: string[]): ProjectScan {
  return {
    type: 'node',
    name,
    path: `/test/${name}`,
    frameworks: [],
    dependencies: deps.map(makeDep),
    dependencyAgeBuckets: { current: 0, oneBehind: 0, twoPlusBehind: 0, unknown: 0 },
  };
}

describe('scanFileHotspots', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('returns zeros for empty directory', async () => {
    const result = await scanFileHotspots(tempDir);
    expect(result.totalFiles).toBe(0);
    expect(result.largestFiles).toEqual([]);
    expect(result.fileCountByExtension).toEqual({});
    expect(result.maxDirectoryDepth).toBe(0);
  });

  it('counts files by extension', async () => {
    await fs.writeFile(path.join(tempDir, 'app.ts'), 'export {}');
    await fs.writeFile(path.join(tempDir, 'utils.ts'), 'export {}');
    await fs.writeFile(path.join(tempDir, 'index.js'), '');
    const result = await scanFileHotspots(tempDir);
    expect(result.fileCountByExtension['.ts']).toBe(2);
    expect(result.fileCountByExtension['.js']).toBe(1);
    expect(result.totalFiles).toBe(3);
  });

  it('tracks largest files sorted by size descending', async () => {
    await fs.writeFile(path.join(tempDir, 'small.ts'), 'x');
    await fs.writeFile(path.join(tempDir, 'big.ts'), 'x'.repeat(1000));
    await fs.writeFile(path.join(tempDir, 'medium.ts'), 'x'.repeat(100));
    const result = await scanFileHotspots(tempDir);
    expect(result.largestFiles.length).toBe(3);
    expect(result.largestFiles[0]!.path).toBe('big.ts');
    expect(result.largestFiles[0]!.bytes).toBe(1000);
    expect(result.largestFiles[1]!.path).toBe('medium.ts');
    expect(result.largestFiles[2]!.path).toBe('small.ts');
  });

  it('limits largest files to 20', async () => {
    for (let i = 0; i < 25; i++) {
      await fs.writeFile(path.join(tempDir, `file${i}.ts`), 'x'.repeat(i + 1));
    }
    const result = await scanFileHotspots(tempDir);
    expect(result.largestFiles.length).toBe(20);
    expect(result.totalFiles).toBe(25);
  });

  it('calculates max directory depth', async () => {
    const deep = path.join(tempDir, 'a', 'b', 'c', 'd');
    await fs.mkdir(deep, { recursive: true });
    await fs.writeFile(path.join(deep, 'leaf.ts'), '');
    const result = await scanFileHotspots(tempDir);
    expect(result.maxDirectoryDepth).toBeGreaterThanOrEqual(4);
  });

  it('skips node_modules', async () => {
    await fs.mkdir(path.join(tempDir, 'node_modules', 'pkg'), { recursive: true });
    await fs.writeFile(path.join(tempDir, 'node_modules', 'pkg', 'index.js'), 'big');
    await fs.writeFile(path.join(tempDir, 'app.ts'), 'code');
    const result = await scanFileHotspots(tempDir);
    expect(result.totalFiles).toBe(1);
    expect(result.fileCountByExtension['.js']).toBeUndefined();
  });

  it('skips .git directory', async () => {
    await fs.mkdir(path.join(tempDir, '.git'), { recursive: true });
    await fs.writeFile(path.join(tempDir, '.git', 'HEAD'), 'ref: refs/heads/main');
    await fs.writeFile(path.join(tempDir, 'app.ts'), 'code');
    const result = await scanFileHotspots(tempDir);
    expect(result.totalFiles).toBe(1);
  });

  it('skips binary/media extensions like .png .map', async () => {
    await fs.writeFile(path.join(tempDir, 'logo.png'), 'binary');
    await fs.writeFile(path.join(tempDir, 'bundle.js.map'), 'sourcemap');
    await fs.writeFile(path.join(tempDir, 'app.ts'), 'code');
    const result = await scanFileHotspots(tempDir);
    expect(result.totalFiles).toBe(1);
    expect(result.fileCountByExtension['.png']).toBeUndefined();
    expect(result.fileCountByExtension['.map']).toBeUndefined();
  });

  it('counts files in nested directories', async () => {
    const sub = path.join(tempDir, 'src', 'components');
    await fs.mkdir(sub, { recursive: true });
    await fs.writeFile(path.join(sub, 'Button.tsx'), 'export const B = 1');
    await fs.writeFile(path.join(sub, 'Input.tsx'), 'export const I = 1');
    await fs.writeFile(path.join(tempDir, 'src', 'index.ts'), '');
    const result = await scanFileHotspots(tempDir);
    expect(result.fileCountByExtension['.tsx']).toBe(2);
    expect(result.fileCountByExtension['.ts']).toBe(1);
    expect(result.totalFiles).toBe(3);
  });

  it('handles files without extensions', async () => {
    await fs.writeFile(path.join(tempDir, 'Makefile'), 'all:');
    await fs.writeFile(path.join(tempDir, 'Dockerfile'), 'FROM node');
    const result = await scanFileHotspots(tempDir);
    expect(result.totalFiles).toBe(2);
    // Files without extensions have empty string extension
    expect(result.fileCountByExtension['']).toBe(2);
  });
});

describe('computePackageCentrality', () => {
  it('returns empty for no projects', () => {
    const result = computePackageCentrality([]);
    expect(result).toEqual([]);
  });

  it('returns empty when no shared packages', () => {
    const p1 = makeProject('a', ['express']);
    const p2 = makeProject('b', ['fastify']);
    const result = computePackageCentrality([p1, p2]);
    expect(result).toEqual([]);
  });

  it('identifies shared packages across projects', () => {
    const p1 = makeProject('a', ['lodash', 'express']);
    const p2 = makeProject('b', ['lodash', 'react']);
    const p3 = makeProject('c', ['lodash', 'express']);
    const result = computePackageCentrality([p1, p2, p3]);
    const lodash = result.find((p) => p.name === 'lodash');
    expect(lodash).toBeDefined();
    expect(lodash!.referencedInProjects).toBe(3);
    const express = result.find((p) => p.name === 'express');
    expect(express).toBeDefined();
    expect(express!.referencedInProjects).toBe(2);
  });

  it('does not include packages used in only one project', () => {
    const p1 = makeProject('a', ['lodash']);
    const result = computePackageCentrality([p1]);
    expect(result).toEqual([]);
  });

  it('sorts by referencedInProjects descending, then alphabetically', () => {
    const p1 = makeProject('a', ['zlib', 'alpha']);
    const p2 = makeProject('b', ['zlib', 'alpha', 'beta']);
    const p3 = makeProject('c', ['alpha', 'beta']);
    const result = computePackageCentrality([p1, p2, p3]);
    // alpha: 3 projects, zlib: 2, beta: 2
    expect(result[0]!.name).toBe('alpha');
    // zlib and beta both at 2 — sorted alphabetically
    expect(result[1]!.name).toBe('beta');
    expect(result[2]!.name).toBe('zlib');
  });

  it('limits results to 30', () => {
    // Create 2 projects sharing 35 packages
    const deps = Array.from({ length: 35 }, (_, i) => `pkg-${String(i).padStart(2, '0')}`);
    const p1 = makeProject('a', deps);
    const p2 = makeProject('b', deps);
    const result = computePackageCentrality([p1, p2]);
    expect(result.length).toBe(30);
  });
});
