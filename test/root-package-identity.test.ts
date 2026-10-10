/**
 * Root package.json with no name, no version, or neither.
 *
 * `vg build`, `vg scan`, and `vg sbom export` must keep going: one warning,
 * a directory-basename identity, dependencies still resolved, and output that
 * does not contain the absolute path.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { graphSubjectDigest } from '../src/engine/attest.js';
import { buildGraph } from '../src/engine/build.js';
import { fullDependencyGraph } from '../src/engine/lockfile.js';
import { serializeGraph } from '../src/engine/serialize.js';
import { runCoreScan, type ScanArtifact } from '../src/core-open/index.js';
import { WARNING_CODES } from '../src/core-open/warnings.js';
import {
  describeRootPackageIdentity,
  portableRootComponentName,
} from '../src/core-open/utils/root-package-identity.js';
import { toCycloneDx, toSpdx } from '../src/reporting/commands/sbom.js';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/root-package-identity');
const PIN = '2020-01-01T00:00:00.000Z';
const CODE = WARNING_CODES.ROOT_PACKAGE_IDENTITY;

const CASES = [
  {
    id: 'no-name',
    packageName: 'no-name',
    version: '1.2.3',
    nameFallback: true,
    versionFallback: false,
  },
  {
    id: 'no-version',
    packageName: 'named-app',
    version: null,
    nameFallback: false,
    versionFallback: true,
  },
  {
    id: 'neither',
    packageName: 'neither',
    version: null,
    nameFallback: true,
    versionFallback: true,
  },
] as const;

const parents: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  while (parents.length) fs.rmSync(parents.pop()!, { recursive: true, force: true });
});

function copyFixture(id: string): { root: string; parent: string } {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-root-id-'));
  parents.push(parent);
  const root = path.join(parent, id);
  fs.cpSync(path.join(FIXTURES, id), root, { recursive: true });
  return { root, parent };
}

function expectedWarning(id: (typeof CASES)[number]): string {
  return describeRootPackageIdentity(id.packageName, id.nameFallback, id.versionFallback);
}

function buildOpts(root: string) {
  return {
    root,
    generatedAt: PIN,
    inline: true,
    noCache: true,
    noTsc: true,
    noGround: true,
    noIndex: true,
  } as const;
}

function stableScan(artifact: ScanArtifact): string {
  const { timestamp: _timestamp, durationMs: _durationMs, ...rest } = artifact;
  return JSON.stringify(rest);
}

describe('root package.json identity', () => {
  it.each(CASES)('$id: vg build is stable, names the fallback, and keeps the dependency', async (spec) => {
    const { root, parent } = copyFixture(spec.id);
    const first = await buildGraph(buildOpts(root));
    const second = await buildGraph(buildOpts(root));
    expect(graphSubjectDigest(first.graph)).toBe(graphSubjectDigest(second.graph));
    expect(serializeGraph(first.graph)).toBe(serializeGraph(second.graph));

    const pkg = first.graph.nodes.find((node) => node.kind === 'package' && node.file === 'package.json');
    expect(pkg?.qualifiedName).toBe(spec.packageName);
    expect(pkg?.name).toBe(spec.packageName.includes('/') ? spec.packageName.split('/').pop() : spec.packageName);
    expect(first.graph.nodes.some((node) => node.kind === 'external' && node.name === 'left-pad')).toBe(true);

    const warnings = first.codedWarnings.filter((warning) => warning.code === CODE);
    expect(warnings).toEqual([{ code: CODE, message: expectedWarning(spec) }]);
    expect(second.codedWarnings.filter((warning) => warning.code === CODE)).toEqual(warnings);

    const serialized = serializeGraph(first.graph);
    expect(serialized).not.toContain(parent);
    expect(serialized).not.toContain(root);
    expect(warnings[0]!.message).not.toContain(parent);
    expect(warnings[0]!.message).not.toContain('/');
  });

  it('the same basename under two absolute parents is the same package identity', async () => {
    const a = copyFixture('neither');
    const b = copyFixture('neither');
    expect(a.root).not.toBe(b.root);
    const left = await buildGraph(buildOpts(a.root));
    const right = await buildGraph(buildOpts(b.root));
    const packageOf = (nodes: typeof left.graph.nodes) => nodes.find((node) => node.kind === 'package')!;
    expect(packageOf(left.graph.nodes).id).toBe(packageOf(right.graph.nodes).id);
    expect(packageOf(left.graph.nodes).qualifiedName).toBe('neither');
    expect(serializeGraph(left.graph)).not.toContain(a.parent);
    expect(serializeGraph(right.graph)).not.toContain(b.parent);
  });

  it.each(CASES)('$id: vg scan resolves left-pad and warns once', async (spec) => {
    const { root, parent } = copyFixture(spec.id);
    const stderr: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((line?: unknown) => {
      stderr.push(String(line ?? ''));
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const scanOpts = { format: 'json' as const, concurrency: 2, offline: true, quiet: true, vibgrateVersion: 'test' };
    const first = await runCoreScan(root, scanOpts);
    const second = await runCoreScan(root, scanOpts);
    expect(stableScan(first)).toBe(stableScan(second));

    expect(first.rootPath).toBe(spec.id);
    expect(first.repository?.name).toBe(spec.packageName);
    expect(first.repository?.version).toBe(spec.version ?? undefined);
    const project = first.projects.find((item) => item.path === '.');
    expect(project?.name).toBe(spec.packageName);
    const leftPad = project?.dependencies.find((dep) => dep.package === 'left-pad');
    expect(leftPad?.resolvedVersion).toBe('1.3.0');

    const warnings = (first.degradations ?? []).filter((warning) => warning.code === CODE);
    expect(warnings).toEqual([{ code: CODE, message: expectedWarning(spec) }]);
    expect(stderr.filter((line) => line.includes(CODE))).toHaveLength(2);
    expect(stableScan(first)).not.toContain(parent);
    expect(stableScan(first)).not.toContain(root);
    expect(warnings[0]!.message).not.toContain(parent);
  });

  it.each(CASES)('$id: vg sbom export keeps left-pad and is byte-stable', async (spec) => {
    const { root, parent } = copyFixture(spec.id);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const artifact = await runCoreScan(root, {
      format: 'json',
      concurrency: 2,
      offline: true,
      quiet: true,
      vibgrateVersion: 'test',
    });
    const warning = artifact.degradations?.find((item) => item.code === CODE) ?? null;
    expect(warning?.message).toBe(expectedWarning(spec));

    const graph = fullDependencyGraph(root);
    expect(graph?.components).toEqual([{ package: 'left-pad', version: '1.3.0' }]);

    const cyclone = toCycloneDx(artifact, graph, warning);
    const cycloneAgain = toCycloneDx(artifact, graph, warning);
    expect(JSON.stringify(cycloneAgain)).toBe(JSON.stringify(cyclone));
    const spdx = toSpdx(artifact, graph, warning);
    expect(JSON.stringify(toSpdx(artifact, graph, warning))).toBe(JSON.stringify(spdx));

    const meta = (cyclone.metadata as { component: { name: string; version?: string; purl?: string }; properties: Array<{ name: string; value: string }> }).component;
    expect(meta.name).toBe(portableRootComponentName(spec.id));
    expect(meta.name).toBe(spec.id);
    expect(meta.version).toBeUndefined();
    expect(meta.purl).toBeUndefined();
    const properties = (cyclone.metadata as { properties: Array<{ name: string; value: string }> }).properties;
    expect(properties.find((property) => property.name === 'vibgrate:rootIdentityWarning')?.value).toBe(warning?.message);
    expect(properties.find((property) => property.name === 'vibgrate:warningCode')?.value).toBe(CODE);

    const body = JSON.stringify(cyclone);
    expect(body).toContain('pkg:npm/left-pad@1.3.0');
    expect(body).not.toContain(parent);
    expect(body).not.toContain(root);
    const spdxDoc = spdx as {
      name: string;
      annotations?: Array<{ comment: string }>;
    };
    expect(spdxDoc.annotations?.map((annotation) => annotation.comment)).toEqual([
      warning?.message,
      `warningCode=${CODE}`,
    ]);
    expect(JSON.stringify(spdx)).not.toContain(parent);
    expect(spdxDoc.name).toBe(`${spec.id}-sbom`);
  });
});

describe('vg CLI on a package.json with neither name nor version', () => {
  it('build, scan, and sbom export exit 0 and warn once each', () => {
    const { root, parent } = copyFixture('neither');
    const tsx = path.resolve('node_modules/tsx/dist/cli.mjs');
    const cli = path.resolve('src/cli.ts');
    const run = (args: string[]) => {
      const result = spawnSync(process.execPath, [tsx, cli, ...args], {
        cwd: root,
        encoding: 'utf8',
        timeout: 90_000,
        env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', VIBGRATE_GRAPH_IN_REPO: '1' },
      });
      return {
        status: result.status,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        output: `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
        error: result.error,
      };
    };
    const warningLines = (text: string) => text.split('\n').filter((line) => line.includes(`[${CODE}]`));

    const build = run(['build', '--no-html', '--no-report', '--no-tsc', '--no-index', '--no-ground', '--no-warm', '--no-publish']);
    expect(build.error).toBeUndefined();
    expect(build.status).toBe(0);
    const buildAgain = run(['build', '--no-html', '--no-report', '--no-tsc', '--no-index', '--no-ground', '--no-warm', '--no-publish']);
    expect(buildAgain.status).toBe(0);
    const graphPath = path.join(root, '.vibgrate', 'graph.json');
    const graphText = fs.readFileSync(graphPath, 'utf8');
    expect(graphText).not.toContain(parent);
    expect(graphText).toContain('"qualifiedName": "neither"');
    expect(warningLines(build.output)).toHaveLength(1);

    const scan = run(['scan', '--offline', '--quiet', '--no-daemon', '--no-graph', '--format', 'json']);
    expect(scan.error).toBeUndefined();
    expect(scan.status).toBe(0);
    expect(warningLines(scan.stderr)).toHaveLength(1);
    const scanArtifact = JSON.parse(fs.readFileSync(path.join(root, '.vibgrate', 'scan_result.json'), 'utf8')) as ScanArtifact;
    expect(scanArtifact.rootPath).toBe('neither');
    expect(scanArtifact.degradations?.filter((warning) => warning.code === CODE)).toHaveLength(1);
    expect(scanArtifact.projects[0]?.dependencies.find((dep) => dep.package === 'left-pad')?.resolvedVersion).toBe('1.3.0');
    expect(JSON.stringify(scanArtifact)).not.toContain(parent);

    const exported = path.join(root, 'sbom.cdx.json');
    const sbom = run(['sbom', 'export', '--format', 'cyclonedx', '--out', exported]);
    expect(sbom.error).toBeUndefined();
    expect(sbom.status).toBe(0);
    expect(warningLines(sbom.stderr)).toHaveLength(1);
    const again = path.join(root, 'sbom-again.cdx.json');
    const sbomAgain = run(['sbom', 'export', '--format', 'cyclonedx', '--out', again]);
    expect(sbomAgain.status).toBe(0);
    expect(fs.readFileSync(again, 'utf8')).toBe(fs.readFileSync(exported, 'utf8'));
    const doc = fs.readFileSync(exported, 'utf8');
    expect(doc).toContain('pkg:npm/left-pad@1.3.0');
    expect(doc).toContain(CODE);
    expect(doc).not.toContain(parent);
    expect(doc).not.toContain(root);
  }, 120_000);
});
