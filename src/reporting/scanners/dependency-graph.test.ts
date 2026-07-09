import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { scanDependencyGraph } from './dependency-graph.js';

async function createTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(tmpdir(), 'vibgrate-depgraph-test-'));
}

describe('scanDependencyGraph', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('returns null lockfileType when no lockfile exists', async () => {
    const result = await scanDependencyGraph(tempDir);
    expect(result.lockfileType).toBeNull();
    expect(result.totalUnique).toBe(0);
    expect(result.totalInstalled).toBe(0);
  });

  // ── pnpm-lock.yaml ──

  it('parses pnpm-lock.yaml and counts unique packages', async () => {
    await fs.writeFile(
      path.join(tempDir, 'pnpm-lock.yaml'),
      `lockfileVersion: '9.0'

packages:
  express@4.18.2:
    resolution: {integrity: sha512-xxx}
  lodash@4.17.21:
    resolution: {integrity: sha512-yyy}
`,
    );
    const result = await scanDependencyGraph(tempDir);
    expect(result.lockfileType).toBe('pnpm');
    expect(result.totalUnique).toBe(2);
    expect(result.totalInstalled).toBe(2);
    expect(result.duplicatedPackages).toEqual([]);
  });

  it('detects duplicate versions in pnpm-lock.yaml', async () => {
    await fs.writeFile(
      path.join(tempDir, 'pnpm-lock.yaml'),
      `lockfileVersion: '9.0'

packages:
  lodash@4.17.21:
    resolution: {integrity: sha512-a}
  lodash@3.10.1:
    resolution: {integrity: sha512-b}
  express@4.18.2:
    resolution: {integrity: sha512-c}
`,
    );
    const result = await scanDependencyGraph(tempDir);
    expect(result.totalUnique).toBe(2); // lodash + express
    expect(result.totalInstalled).toBe(3); // 2 lodash + 1 express
    expect(result.duplicatedPackages).toHaveLength(1);
    expect(result.duplicatedPackages[0]!.name).toBe('lodash');
    expect(result.duplicatedPackages[0]!.versions).toEqual(['3.10.1', '4.17.21']);
  });

  it('handles scoped packages in pnpm-lock.yaml', async () => {
    await fs.writeFile(
      path.join(tempDir, 'pnpm-lock.yaml'),
      `lockfileVersion: '9.0'

packages:
  /@nestjs/core@10.0.0:
    resolution: {integrity: sha512-x}
  /@nestjs/common@10.0.0:
    resolution: {integrity: sha512-y}
`,
    );
    const result = await scanDependencyGraph(tempDir);
    expect(result.lockfileType).toBe('pnpm');
    expect(result.totalUnique).toBe(2);
  });

  // ── package-lock.json ──

  it('parses package-lock.json v3 format', async () => {
    await fs.writeFile(
      path.join(tempDir, 'package-lock.json'),
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          '': { name: 'root', version: '1.0.0' },
          'node_modules/express': { version: '4.18.2' },
          'node_modules/lodash': { version: '4.17.21' },
        },
      }),
    );
    const result = await scanDependencyGraph(tempDir);
    expect(result.lockfileType).toBe('npm');
    expect(result.totalUnique).toBe(2);
    expect(result.totalInstalled).toBe(2);
  });

  it('detects duplicates in package-lock.json with nested node_modules', async () => {
    await fs.writeFile(
      path.join(tempDir, 'package-lock.json'),
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          '': { name: 'root', version: '1.0.0' },
          'node_modules/lodash': { version: '4.17.21' },
          'node_modules/foo/node_modules/lodash': { version: '3.10.1' },
        },
      }),
    );
    const result = await scanDependencyGraph(tempDir);
    expect(result.duplicatedPackages).toHaveLength(1);
    expect(result.duplicatedPackages[0]!.name).toBe('lodash');
    expect(result.duplicatedPackages[0]!.versions).toEqual(['3.10.1', '4.17.21']);
  });

  // ── yarn.lock ──

  it('parses yarn.lock format', async () => {
    await fs.writeFile(
      path.join(tempDir, 'yarn.lock'),
      `# yarn lockfile v1

"express@^4.18.0":
  version "4.18.2"
  resolved "https://registry.yarnpkg.com/express/-/express-4.18.2.tgz"

"lodash@^4.17.0":
  version "4.17.21"
  resolved "https://registry.yarnpkg.com/lodash/-/lodash-4.17.21.tgz"
`,
    );
    const result = await scanDependencyGraph(tempDir);
    expect(result.lockfileType).toBe('yarn');
    expect(result.totalUnique).toBe(2);
  });

  // ── phantom dependencies ──

  it('detects phantom dependencies (in package.json but not in lockfile)', async () => {
    await fs.writeFile(
      path.join(tempDir, 'pnpm-lock.yaml'),
      `lockfileVersion: '9.0'

packages:
  express@4.18.2:
    resolution: {integrity: sha512-x}
`,
    );
    await fs.writeFile(
      path.join(tempDir, 'package.json'),
      JSON.stringify({
        dependencies: { express: '^4.18.0', chalk: '^5.0.0' },
      }),
    );
    const result = await scanDependencyGraph(tempDir);
    expect(result.phantomDependencies).toContain('chalk');
    expect(result.phantomDependencies).not.toContain('express');
  });

  it('does not flag workspace: dependencies as phantoms', async () => {
    await fs.writeFile(
      path.join(tempDir, 'pnpm-lock.yaml'),
      `lockfileVersion: '9.0'

packages:
  express@4.18.2:
    resolution: {integrity: sha512-x}
`,
    );
    await fs.writeFile(
      path.join(tempDir, 'package.json'),
      JSON.stringify({
        dependencies: { express: '^4.18.0', '@my/lib': 'workspace:*' },
      }),
    );
    const result = await scanDependencyGraph(tempDir);
    expect(result.phantomDependencies).not.toContain('@my/lib');
  });

  // ── priority ──

  it('prefers pnpm-lock.yaml over package-lock.json', async () => {
    await fs.writeFile(
      path.join(tempDir, 'pnpm-lock.yaml'),
      `lockfileVersion: '9.0'

packages:
  express@4.18.2:
    resolution: {integrity: sha512-x}
`,
    );
    await fs.writeFile(
      path.join(tempDir, 'package-lock.json'),
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          '': { name: 'root' },
          'node_modules/lodash': { version: '4.17.21' },
        },
      }),
    );
    const result = await scanDependencyGraph(tempDir);
    expect(result.lockfileType).toBe('pnpm');
  });

  it('sorts duplicated packages by version count descending', async () => {
    await fs.writeFile(
      path.join(tempDir, 'pnpm-lock.yaml'),
      `lockfileVersion: '9.0'

packages:
  lodash@4.17.21:
    resolution: {integrity: sha512-a}
  lodash@3.10.1:
    resolution: {integrity: sha512-b}
  lodash@2.0.0:
    resolution: {integrity: sha512-c}
  chalk@5.0.0:
    resolution: {integrity: sha512-d}
  chalk@4.0.0:
    resolution: {integrity: sha512-e}
`,
    );
    const result = await scanDependencyGraph(tempDir);
    expect(result.duplicatedPackages.length).toBe(2);
    // lodash has 3 versions, chalk has 2 — lodash should sort first
    expect(result.duplicatedPackages[0]!.name).toBe('lodash');
    expect(result.duplicatedPackages[1]!.name).toBe('chalk');
  });

  it('handles empty lockfile gracefully', async () => {
    await fs.writeFile(path.join(tempDir, 'pnpm-lock.yaml'), '');
    const result = await scanDependencyGraph(tempDir);
    expect(result.lockfileType).toBe('pnpm');
    expect(result.totalUnique).toBe(0);
    expect(result.totalInstalled).toBe(0);
  });
});
