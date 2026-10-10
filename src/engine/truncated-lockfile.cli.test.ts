import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, afterEach } from 'vitest';

/**
 * A truncated lockfile must fail the CLI: non-zero exit, the lockfile path,
 * and a stable reason. The message must not echo file contents.
 */
const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const cli = path.join(pkgRoot, 'src/cli.ts');
const fixtureDir = path.join(pkgRoot, 'test/__fixtures__/truncated-lockfile');
const secret = 'npm_DDDDDDDDDDDDDDDDDDDD';

function fixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-trunc-lock-'));
  fs.writeFileSync(
    path.join(dir, 'package-lock.json'),
    `{"name":"fixture","lockfileVersion":3,"packages":{"node_modules/left-pad":{"version":"1.0.0","integrity":"${secret}"`,
  );
  fs.writeFileSync(path.join(dir, 'app.ts'), 'export const n = 1;\n');
  return dir;
}

function copyFixture(dir: string, name: string, destName = name): void {
  fs.copyFileSync(path.join(fixtureDir, name), path.join(dir, destName));
}

/** Parent exited. An orphan parse worker would still mention the fixture path. */
function assertNoOrphan(dir: string): void {
  let listing = '';
  try {
    listing = execFileSync('ps', ['-eo', 'args'], { encoding: 'utf8' });
  } catch {
    return;
  }
  expect(listing).not.toContain(dir);
}

function run(dir: string, command: 'scan' | 'build', graph = false): { status: number | null; signal: NodeJS.Signals | null; stderr: string; error?: Error } {
  // `-C` makes the fixture the project root. A path argument alone is a scope
  // inside the process cwd, so a lockfile outside that cwd would be skipped.
  const scanArgs = [cli, 'scan', dir, '--offline', '--no-daemon', '--quiet'];
  if (!graph) scanArgs.push('--no-graph');
  const args =
    command === 'scan'
      ? scanArgs
      : [cli, 'build', '-C', dir, '--no-warm', '--no-publish', '--offline', '--no-daemon'];
  const res = spawnSync(process.execPath, ['--import', 'tsx', ...args], {
    cwd: pkgRoot,
    encoding: 'utf8',
    timeout: 45_000,
    env: {
      ...process.env,
      NO_COLOR: '1',
      VIBGRATE_NO_KERNEL: '1',
      VIBGRATE_DSN: '',
    },
  });
  return { status: res.status, signal: res.signal, stderr: res.stderr ?? '', error: res.error };
}

describe('truncated lockfile CLI', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('vg scan exits non-zero with the lockfile path and no file contents', () => {
    const dir = fixture();
    dirs.push(dir);
    const res = run(dir, 'scan');
    expect(res.error).toBeUndefined();
    expect(res.signal).toBeNull();
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('package-lock.json');
    expect(res.stderr).toContain('truncated or invalid JSON');
    expect(res.stderr).toContain('package manager');
    expect(res.stderr).not.toContain(secret);
    expect(res.stderr).not.toContain('left-pad');
    assertNoOrphan(dir);
  }, 60_000);

  it('vg scan fails a nested package-lock.json before reporting an empty graph', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-trunc-lock-'));
    dirs.push(dir);
    fs.mkdirSync(path.join(dir, 'packages', 'web'), { recursive: true });
    copyFixture(path.join(dir, 'packages', 'web'), 'package-lock.json');
    fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"root","version":"1.0.0"}\n');
    fs.writeFileSync(path.join(dir, 'app.ts'), 'export const n = 1;\n');
    const res = run(dir, 'scan');
    expect(res.error).toBeUndefined();
    expect(res.signal).toBeNull();
    expect(res.status).toBe(1);
    expect(res.stderr).toContain(path.join(dir, 'packages', 'web', 'package-lock.json'));
    expect(res.stderr).toContain('truncated or invalid JSON');
    expect(res.stderr).toContain('package manager');
    expect(res.stderr).not.toContain('left-pad');
    expect(res.stderr).not.toContain('map build failed');
    expect(fs.existsSync(path.join(dir, '.vibgrate'))).toBe(false);
    assertNoOrphan(dir);
  }, 60_000);

  it('vg scan with a code map does not skip a nested truncated lockfile', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-trunc-lock-'));
    dirs.push(dir);
    fs.mkdirSync(path.join(dir, 'packages', 'web'), { recursive: true });
    copyFixture(path.join(dir, 'packages', 'web'), 'package-lock.json');
    fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"root","version":"1.0.0"}\n');
    fs.writeFileSync(path.join(dir, 'app.ts'), 'export const n = 1;\n');
    const res = run(dir, 'scan', true);
    expect(res.error).toBeUndefined();
    expect(res.signal).toBeNull();
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('truncated or invalid JSON');
    expect(res.stderr).toContain('package manager');
    expect(res.stderr).not.toContain('left-pad');
    expect(res.stderr).not.toContain('map build failed');
    expect(fs.existsSync(path.join(dir, '.vibgrate', 'graph.json'))).toBe(false);
    assertNoOrphan(dir);
  }, 60_000);

  it('vg scan fails a truncated yarn.lock and pnpm-lock.yaml from the fixture', () => {
    for (const [name, kind] of [
      ['yarn.lock', 'yarn.lock'],
      ['pnpm-lock.yaml', 'YAML'],
    ] as const) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-trunc-lock-'));
      dirs.push(dir);
      copyFixture(dir, name);
      fs.writeFileSync(path.join(dir, 'app.ts'), 'export const n = 1;\n');
      const res = run(dir, 'scan');
      expect(res.error, name).toBeUndefined();
      expect(res.signal, name).toBeNull();
      expect(res.status, name).toBe(1);
      expect(res.stderr, name).toContain(name);
      expect(res.stderr, name).toContain(`truncated or invalid ${kind}`);
      expect(res.stderr, name).toContain('package manager');
      expect(res.stderr, name).not.toContain('left-pad');
      expect(res.stderr, name).not.toContain('sha512-abc');
      assertNoOrphan(dir);
    }
  }, 60_000);

  it('vg build exits non-zero before parse workers stay up', () => {
    const dir = fixture();
    dirs.push(dir);
    const res = run(dir, 'build');
    expect(res.error).toBeUndefined();
    expect(res.signal).toBeNull();
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('package-lock.json');
    expect(res.stderr).toContain('truncated or invalid JSON');
    expect(res.stderr).not.toContain(secret);
    expect(fs.existsSync(path.join(dir, '.vibgrate', 'graph.json'))).toBe(false);
    assertNoOrphan(dir);
  }, 60_000);
});
