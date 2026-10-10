/**
 * A root package.json may omit name, version, or both. vg build, vg scan, and
 * vg sbom export must not crash, must keep the resolved dependency, and must
 * emit one stable warning. Output must not contain the absolute path.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildGraph } from '../src/engine/build.js';
import { runCoreScan } from '../src/core-open/index.js';
import type { ScanArtifact } from '../src/core-open/types.js';
import { sbomCommand } from '../src/reporting/commands/sbom.js';

const CODE = 'VG_WARN_ROOT_PACKAGE_IDENTITY';
const PIN = '2020-01-01T00:00:00.000Z';
const DIR_NAME = 'app';

const LOCKFILE = `{
  "lockfileVersion": 3,
  "requires": true,
  "packages": {
    "": {
      "dependencies": {
        "left-pad": "1.3.0"
      }
    },
    "node_modules/left-pad": {
      "version": "1.3.0"
    }
  }
}
`;

const parents: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  while (parents.length) fs.rmSync(parents.pop()!, { recursive: true, force: true });
});

function writeFixture(pkg: Record<string, unknown>): { parent: string; root: string } {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-root-pkg-'));
  parents.push(parent);
  const root = path.join(parent, DIR_NAME);
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  fs.writeFileSync(path.join(root, 'package-lock.json'), LOCKFILE);
  fs.writeFileSync(path.join(root, 'index.js'), 'module.exports = require("left-pad");\n');
  return { parent, root };
}

function assertNoAbsolutePath(text: string, parent: string): void {
  expect(text).not.toContain(parent);
  expect(text).not.toContain(path.basename(parent));
}

function stableScan(artifact: ScanArtifact): string {
  const copy = structuredClone(artifact);
  copy.timestamp = PIN;
  delete copy.durationMs;
  return JSON.stringify(copy);
}

async function buildTwice(root: string) {
  const opts = {
    root,
    generatedAt: PIN,
    inline: true,
    noCache: true,
    noIndex: true,
    noGround: true,
    noTsc: true,
    fast: true,
    noScip: true,
    noCoverage: true,
  };
  const first = await buildGraph(opts);
  const second = await buildGraph(opts);
  return { first, second };
}

async function scanTwice(root: string): Promise<[ScanArtifact, ScanArtifact]> {
  vi.stubEnv('VIBGRATE_DSN', '');
  const opts = {
    format: 'json' as const,
    concurrency: 1,
    offline: true,
    noLocalArtifacts: true,
    quiet: true,
    vibgrateVersion: 'test',
  };
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const first = await runCoreScan(root, opts);
    const second = await runCoreScan(root, opts);
    const errText = err.mock.calls.map((call) => call.map(String).join(' ')).join('\n');
    const identityLines = errText.split(CODE).length - 1;
    expect(identityLines).toBe(2);
    return [first, second];
  } finally {
    log.mockRestore();
    err.mockRestore();
  }
}

async function exportTwice(root: string, artifact: ScanArtifact): Promise<[string, string, string]> {
  const pinned = structuredClone(artifact);
  pinned.timestamp = PIN;
  pinned.durationMs = 0;
  const artifactPath = path.join(root, 'scan.json');
  fs.writeFileSync(artifactPath, JSON.stringify(pinned));
  const stdout: string[] = [];
  const stderr: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    stdout.push(args.map(String).join(' '));
  });
  const err = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    stderr.push(args.map(String).join(' '));
  });
  try {
    await sbomCommand.parseAsync(['export', '--in', artifactPath, '--root', root, '--format', 'cyclonedx'], { from: 'user' });
    await sbomCommand.parseAsync(['export', '--in', artifactPath, '--root', root, '--format', 'spdx'], { from: 'user' });
    await sbomCommand.parseAsync(['export', '--in', artifactPath, '--root', root, '--format', 'cyclonedx'], { from: 'user' });
  } finally {
    log.mockRestore();
    err.mockRestore();
  }
  return [stdout[0] ?? '', stdout[2] ?? '', stderr.join('\n')];
}

describe('root package.json missing name or version', () => {
  it('uses the directory name when name is missing, and keeps the declared version', async () => {
    const { parent, root } = writeFixture({ version: '1.2.3', dependencies: { 'left-pad': '1.3.0' } });
    const { first, second } = await buildTwice(root);
    const graphText = JSON.stringify(first.graph);
    expect(graphText).toBe(JSON.stringify(second.graph));
    assertNoAbsolutePath(graphText, parent);
    const pkg = first.graph.nodes.find((node) => node.kind === 'package' && node.file === 'package.json');
    expect(pkg?.qualifiedName).toBe(DIR_NAME);
    expect(pkg?.name).toBe(DIR_NAME);
    expect(first.graph.nodes.some((node) => node.kind === 'external' && node.name === 'left-pad')).toBe(true);
    expect(first.codedWarnings.filter((warning) => warning.code === CODE)).toEqual([
      {
        code: CODE,
        message: 'Root package.json has no name. The root component name is the directory name "app". Dependencies are still resolved.',
      },
    ]);

    const [scanA, scanB] = await scanTwice(root);
    expect(stableScan(scanA)).toBe(stableScan(scanB));
    assertNoAbsolutePath(stableScan(scanA), parent);
    expect(scanA.rootPath).toBe(DIR_NAME);
    expect(scanA.repository.name).toBe(DIR_NAME);
    expect(scanA.repository.version).toBe('1.2.3');
    expect(scanA.projects.map((project) => project.name)).toEqual([DIR_NAME]);
    expect(scanA.projects[0]?.dependencies.map((dep) => [dep.package, dep.resolvedVersion])).toEqual([['left-pad', '1.3.0']]);
    expect(scanA.degradations?.filter((warning) => warning.code === CODE)).toHaveLength(1);

    const [cdxA, cdxB, stderr] = await exportTwice(root, scanA);
    expect(cdxA).toBe(cdxB);
    assertNoAbsolutePath(cdxA, parent);
    assertNoAbsolutePath(stderr, parent);
    const doc = JSON.parse(cdxA) as {
      metadata: { component: { name: string; version?: string } };
      components: Array<{ name: string; version: string }>;
    };
    expect(doc.metadata.component.name).toBe(DIR_NAME);
    expect(doc.metadata.component.version).toBeUndefined();
    expect(doc.components).toContainEqual(expect.objectContaining({ name: 'left-pad', version: '1.3.0' }));
    expect(stderr.split(CODE).length - 1).toBe(3);
  });

  it('keeps the declared name and omits version when version is missing', async () => {
    const { parent, root } = writeFixture({ name: 'named-app', dependencies: { 'left-pad': '1.3.0' } });
    const { first, second } = await buildTwice(root);
    expect(JSON.stringify(first.graph)).toBe(JSON.stringify(second.graph));
    assertNoAbsolutePath(JSON.stringify(first.graph), parent);
    const pkg = first.graph.nodes.find((node) => node.kind === 'package' && node.file === 'package.json');
    expect(pkg?.qualifiedName).toBe('named-app');
    expect(first.graph.nodes.some((node) => node.kind === 'external' && node.name === 'left-pad')).toBe(true);
    expect(first.codedWarnings.filter((warning) => warning.code === CODE).map((warning) => warning.message)).toEqual([
      'Root package.json has no version. The root component version is omitted. Dependencies are still resolved.',
    ]);

    const [scanA, scanB] = await scanTwice(root);
    expect(stableScan(scanA)).toBe(stableScan(scanB));
    assertNoAbsolutePath(stableScan(scanA), parent);
    expect(scanA.repository.name).toBe('named-app');
    expect(scanA.repository.version).toBeUndefined();
    expect(scanA.projects[0]?.name).toBe('named-app');
    expect(scanA.projects[0]?.dependencies.map((dep) => dep.resolvedVersion)).toEqual(['1.3.0']);

    const [cdxA, cdxB, stderr] = await exportTwice(root, scanA);
    expect(cdxA).toBe(cdxB);
    assertNoAbsolutePath(`${cdxA}\n${stderr}`, parent);
    const doc = JSON.parse(cdxA) as { components: Array<{ name: string; version: string }> };
    expect(doc.components).toContainEqual(expect.objectContaining({ name: 'left-pad', version: '1.3.0' }));
    expect(stderr.split(CODE).length - 1).toBe(3);
  });

  it('uses the directory name and omits version when both are missing', async () => {
    const { parent, root } = writeFixture({ dependencies: { 'left-pad': '1.3.0' } });
    const { first, second } = await buildTwice(root);
    const graphText = JSON.stringify(first.graph);
    expect(graphText).toBe(JSON.stringify(second.graph));
    assertNoAbsolutePath(graphText, parent);
    const pkg = first.graph.nodes.find((node) => node.kind === 'package' && node.file === 'package.json');
    expect(pkg?.qualifiedName).toBe(DIR_NAME);
    expect(first.graph.nodes.some((node) => node.kind === 'external' && node.name === 'left-pad')).toBe(true);
    expect(first.codedWarnings.filter((warning) => warning.code === CODE).map((warning) => warning.message)).toEqual([
      'Root package.json has no name or version. The root component name is the directory name "app", and the version is omitted. Dependencies are still resolved.',
    ]);

    const [scanA, scanB] = await scanTwice(root);
    expect(stableScan(scanA)).toBe(stableScan(scanB));
    assertNoAbsolutePath(stableScan(scanA), parent);
    expect(scanA.repository).toEqual({ name: DIR_NAME });
    expect(scanA.projects[0]?.dependencies.some((dep) => dep.package === 'left-pad' && dep.resolvedVersion === '1.3.0')).toBe(true);

    const pinned = structuredClone(scanA);
    pinned.timestamp = PIN;
    pinned.durationMs = 0;
    const artifactPath = path.join(root, 'scan.json');
    fs.writeFileSync(artifactPath, JSON.stringify(pinned));
    const stdout: string[] = [];
    const errLines: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      stdout.push(args.map(String).join(' '));
    });
    const err = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errLines.push(args.map(String).join(' '));
    });
    try {
      await sbomCommand.parseAsync(['export', '--in', artifactPath, '--root', root, '--format', 'spdx'], { from: 'user' });
      await sbomCommand.parseAsync(['export', '--in', artifactPath, '--root', root, '--format', 'spdx'], { from: 'user' });
    } finally {
      log.mockRestore();
      err.mockRestore();
    }
    const spdxFirst = stdout[0] ?? '';
    const spdxAgain = stdout[1] ?? '';
    const stderr = errLines.join('\n');
    expect(spdxAgain).toBe(spdxFirst);
    assertNoAbsolutePath(`${spdxFirst}\n${stderr}`, parent);
    const doc = JSON.parse(spdxFirst) as { name: string; packages: Array<{ name: string; versionInfo: string }> };
    expect(doc.name).toBe(`${DIR_NAME}-sbom`);
    expect(doc.packages).toContainEqual(expect.objectContaining({ name: 'left-pad', versionInfo: '1.3.0' }));
    expect(stderr.split(CODE).length - 1).toBe(2);
  });

  it('does not warn when name and version are both set', async () => {
    const { parent, root } = writeFixture({
      name: 'named-app',
      version: '1.2.3',
      dependencies: { 'left-pad': '1.3.0' },
    });
    const { first, second } = await buildTwice(root);
    expect(JSON.stringify(first.graph)).toBe(JSON.stringify(second.graph));
    expect(first.codedWarnings.some((warning) => warning.code === CODE)).toBe(false);
    assertNoAbsolutePath(JSON.stringify(first.graph), parent);
    const pkg = first.graph.nodes.find((node) => node.kind === 'package' && node.file === 'package.json');
    expect(pkg?.qualifiedName).toBe('named-app');
    expect(first.graph.nodes.some((node) => node.kind === 'external' && node.name === 'left-pad')).toBe(true);

    vi.stubEnv('VIBGRATE_DSN', '');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    let scanA: ScanArtifact;
    let errText = '';
    try {
      scanA = await runCoreScan(root, {
        format: 'json',
        concurrency: 1,
        offline: true,
        noLocalArtifacts: true,
        quiet: true,
        vibgrateVersion: 'test',
      });
      errText = err.mock.calls.map((call) => call.map(String).join(' ')).join('\n');
    } finally {
      log.mockRestore();
      err.mockRestore();
    }
    expect(errText).not.toContain(CODE);
    expect(scanA.degradations?.some((warning) => warning.code === CODE)).toBeFalsy();
    expect(scanA.repository).toEqual({ name: 'named-app', version: '1.2.3' });
    expect(scanA.projects[0]?.name).toBe('named-app');
    expect(scanA.projects[0]?.dependencies.map((dep) => [dep.package, dep.resolvedVersion])).toEqual([['left-pad', '1.3.0']]);
    assertNoAbsolutePath(stableScan(scanA), parent);

    const pinned = structuredClone(scanA);
    pinned.timestamp = PIN;
    pinned.durationMs = 0;
    const artifactPath = path.join(root, 'scan.json');
    fs.writeFileSync(artifactPath, JSON.stringify(pinned));
    const stdout: string[] = [];
    const stderr: string[] = [];
    const log2 = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      stdout.push(args.map(String).join(' '));
    });
    const err2 = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      stderr.push(args.map(String).join(' '));
    });
    try {
      await sbomCommand.parseAsync(['export', '--in', artifactPath, '--root', root, '--format', 'cyclonedx'], { from: 'user' });
      await sbomCommand.parseAsync(['export', '--in', artifactPath, '--root', root, '--format', 'cyclonedx'], { from: 'user' });
    } finally {
      log2.mockRestore();
      err2.mockRestore();
    }
    const errOut = stderr.join('\n');
    expect(errOut).not.toContain(CODE);
    expect(stdout[0]).toBe(stdout[1]);
    assertNoAbsolutePath(`${stdout.join('\n')}\n${errOut}`, parent);
    const doc = JSON.parse(stdout[0] ?? '{}') as {
      metadata: { component: { name: string } };
      components: Array<{ name: string; version: string }>;
    };
    expect(doc.metadata.component.name).toBe(DIR_NAME);
    expect(doc.components).toContainEqual(expect.objectContaining({ name: 'left-pad', version: '1.3.0' }));
  });
});
