import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * `vg scan <path>` and `vg build <path>` read the project at `<path>`.
 * A lockfile, `node_modules` tree, or `.vibgrate/config.yml` in the current
 * working directory must not change the result. The fixture is two sibling
 * projects so a walk that only climbs to a parent cannot see the decoy.
 *
 * Normalisation before comparing the two working directories:
 * - scan JSON drops `timestamp` and `durationMs` (wall clock)
 * - absolute paths of the target directory are rewritten to `<target>`
 * - scan JSON is compared as data, not bytes. Extended scanners finish
 *   concurrently, so object key order can differ between two runs of the
 *   same tree. A decoy version, config value, or path is still a failure.
 * - stderr progress lines include elapsed time (`0.1s`). Those durations
 *   are rewritten to `<duration>`.
 *
 * `vg sbom export` takes `--root <dir>` rather than a positional path. The
 * export is run against one scan artifact from both working directories.
 */

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(pkgRoot, 'src/cli.ts');
// `--import tsx` resolves the package from the process cwd. The cwd under test
// is a fixture, so load the runner by file URL from this repo instead.
const tsxLoader = pathToFileURL(path.join(pkgRoot, 'node_modules/tsx/dist/loader.mjs')).href;
const PIN = '2020-01-01T00:00:00.000Z';

const DECOY_MARKERS = [
  'cwd-decoy-pkg',
  'decoy-only-pkg',
  'cwd-installed-only',
  'CWD_DECOY_SOURCE',
  'from-cwd-decoy-config',
  '9.9.9',
  '8.8.8',
  '7.7.7',
  '6.6.6',
] as const;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function writeProject(dir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}

function lockfile(name: string, deps: Record<string, string>): string {
  const packages: Record<string, { name?: string; version: string; dependencies?: Record<string, string> }> = {
    '': { name, version: '1.0.0', dependencies: deps },
  };
  for (const [pkg, version] of Object.entries(deps)) {
    packages[`node_modules/${pkg}`] = { version };
  }
  return `${JSON.stringify({ name, lockfileVersion: 3, requires: true, packages }, null, 2)}\n`;
}

function fixture(): { parent: string; decoy: string; target: string } {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-cwd-isolation-'));
  dirs.push(parent);
  const decoy = path.join(parent, 'cwd-decoy');
  const target = path.join(parent, 'target');
  writeProject(decoy, {
    'package.json': `${JSON.stringify({
      name: 'cwd-decoy-pkg',
      version: '0.0.1',
      dependencies: { 'left-pad': '9.9.9', 'decoy-only-pkg': '8.8.8' },
    }, null, 2)}\n`,
    'package-lock.json': lockfile('cwd-decoy-pkg', { 'left-pad': '9.9.9', 'decoy-only-pkg': '8.8.8' }),
    'node_modules/left-pad/package.json': `${JSON.stringify({ name: 'left-pad', version: '7.7.7' })}\n`,
    'node_modules/decoy-only-pkg/package.json': `${JSON.stringify({ name: 'decoy-only-pkg', version: '8.8.8' })}\n`,
    'node_modules/cwd-installed-only/package.json': `${JSON.stringify({ name: 'cwd-installed-only', version: '6.6.6' })}\n`,
    '.vibgrate/config.yml': 'exclude:\n  - from-cwd-decoy-config/**\ndriftBudget:\n  mode: warn\n  maxScore: 13\n',
    'src/decoy.ts': 'export const CWD_DECOY_SOURCE = 1;\n',
  });
  writeProject(target, {
    'package.json': `${JSON.stringify({
      name: 'target-app',
      version: '1.0.0',
      dependencies: { 'left-pad': '1.3.0' },
    }, null, 2)}\n`,
    'package-lock.json': lockfile('target-app', { 'left-pad': '1.3.0' }),
    'node_modules/left-pad/package.json': `${JSON.stringify({ name: 'left-pad', version: '1.2.2' })}\n`,
    '.vibgrate/config.yml': 'exclude:\n  - from-target-config/**\ndriftBudget:\n  mode: warn\n  maxScore: 77\n',
    'src/app.ts': 'export function targetHello(): number {\n  return 1;\n}\n',
  });
  return { parent, decoy, target };
}

function run(cwd: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, ['--import', tsxLoader, cli, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 90_000,
    env: {
      ...process.env,
      NO_COLOR: '1',
      VIBGRATE_NO_KERNEL: '1',
      VIBGRATE_DSN: '',
      VIBGRATE_GRAPH_IN_REPO: '1',
    },
  });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

function listFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const name of fs.readdirSync(current).sort()) {
      const abs = path.join(current, name);
      if (fs.statSync(abs).isDirectory()) walk(abs);
      else out.push(path.relative(dir, abs).split(path.sep).join('/'));
    }
  };
  walk(dir);
  return out;
}

function assertNoDecoy(label: string, text: string, decoy: string): void {
  expect(text, label).not.toContain(decoy);
  for (const marker of DECOY_MARKERS) {
    expect(text, `${label} contains ${marker}`).not.toContain(marker);
  }
}

/** Progress elapsed time is wall-clock. The words around it are not. */
function normalizeStderr(text: string, target: string): string {
  return text.split(target).join('<target>').replace(/\b\d+(?:\.\d+)?s\b/g, '<duration>');
}

/** Drop wall-clock fields. Rewrite the target's absolute path and nothing else. */
function normalizeScan(stdout: string, target: string): unknown {
  const artifact = JSON.parse(stdout.split(target).join('<target>')) as Record<string, unknown>;
  delete artifact.timestamp;
  delete artifact.durationMs;
  return artifact;
}

describe('scan and build ignore the working directory', () => {
  it('vg scan <path> matches a scan from inside the project', () => {
    const { decoy, target } = fixture();
    const fromDecoy = run(decoy, ['scan', '../target', '--format', 'json', '--offline', '--no-daemon', '--quiet', '--no-graph']);
    expect(fromDecoy.status, fromDecoy.stderr).toBe(0);
    expect(listFiles(path.join(decoy, '.vibgrate'))).toEqual(['config.yml']);
    expect(fs.existsSync(path.join(target, '.vibgrate', 'scan_result.json'))).toBe(true);

    const fromTarget = run(target, ['scan', '.', '--format', 'json', '--offline', '--no-daemon', '--quiet', '--no-graph']);
    expect(fromTarget.status, fromTarget.stderr).toBe(0);
    expect(listFiles(path.join(decoy, '.vibgrate'))).toEqual(['config.yml']);

    const combined = `${fromDecoy.stdout}\n${fromDecoy.stderr}\n${fromTarget.stdout}\n${fromTarget.stderr}`;
    assertNoDecoy('scan output', combined, decoy);
    expect(fromDecoy.stdout).toContain('target-app');
    expect(fromDecoy.stdout).toContain('1.3.0');
    expect(fromDecoy.stdout).toContain('from-target-config/**');
    expect(normalizeScan(fromDecoy.stdout, target)).toEqual(normalizeScan(fromTarget.stdout, target));
    expect(normalizeStderr(fromDecoy.stderr, target)).toBe(normalizeStderr(fromTarget.stderr, target));
  }, 90_000);

  it('vg build <path> matches a build from inside the project', () => {
    const { decoy, target } = fixture();
    const buildArgs = [
      '--offline',
      '--no-daemon',
      '--no-warm',
      '--no-publish',
      '--no-html',
      '--no-report',
      '--no-cache',
      '--jobs',
      '1',
      '--generated-at',
      PIN,
      '--quiet',
    ];
    const fromDecoy = run(decoy, ['build', '../target', ...buildArgs]);
    expect(fromDecoy.status, fromDecoy.stderr).toBe(0);
    const graphPath = path.join(target, '.vibgrate', 'graph.json');
    expect(fs.existsSync(graphPath), 'graph is written under the project, not the working directory').toBe(true);
    expect(listFiles(path.join(decoy, '.vibgrate'))).toEqual(['config.yml']);
    const firstGraph = fs.readFileSync(graphPath, 'utf8');

    const fromTarget = run(target, ['build', ...buildArgs]);
    expect(fromTarget.status, fromTarget.stderr).toBe(0);
    expect(listFiles(path.join(decoy, '.vibgrate'))).toEqual(['config.yml']);
    const secondGraph = fs.readFileSync(graphPath, 'utf8');

    const combined = `${fromDecoy.stdout}\n${fromDecoy.stderr}\n${fromTarget.stdout}\n${fromTarget.stderr}\n${firstGraph}`;
    assertNoDecoy('build output', combined, decoy);
    expect(firstGraph).toContain('targetHello');
    expect(firstGraph).toContain('src/app.ts');
    expect(firstGraph).toBe(secondGraph);
  }, 90_000);

  it('vg sbom export --root <path> matches an export from inside the project', () => {
    const { decoy, target } = fixture();
    const scan = run(target, ['scan', '.', '--format', 'json', '--offline', '--no-daemon', '--quiet', '--no-graph']);
    expect(scan.status, scan.stderr).toBe(0);

    const fromDecoy = run(decoy, [
      'sbom',
      'export',
      '--in',
      '../target/.vibgrate/scan_result.json',
      '--root',
      '../target',
      '--format',
      'cyclonedx',
    ]);
    const fromTarget = run(target, [
      'sbom',
      'export',
      '--in',
      '.vibgrate/scan_result.json',
      '--root',
      '.',
      '--format',
      'cyclonedx',
    ]);
    expect(fromDecoy.status, fromDecoy.stderr).toBe(0);
    expect(fromTarget.status, fromTarget.stderr).toBe(0);
    expect(listFiles(path.join(decoy, '.vibgrate'))).toEqual(['config.yml']);

    const combined = `${fromDecoy.stdout}\n${fromDecoy.stderr}\n${fromTarget.stdout}\n${fromTarget.stderr}`;
    assertNoDecoy('sbom output', combined, decoy);
    expect(fromDecoy.stdout).toContain('left-pad');
    expect(fromDecoy.stdout).toContain('1.3.0');
    expect(fromDecoy.stdout).toBe(fromTarget.stdout);
    expect(normalizeStderr(fromDecoy.stderr, target)).toBe(normalizeStderr(fromTarget.stderr, target));
  }, 90_000);
});
