import { spawnSync } from 'node:child_process';
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

function run(dir: string, command: 'scan' | 'build'): { status: number | null; signal: NodeJS.Signals | null; stderr: string; error?: Error } {
  // `-C` makes the fixture the project root. A path argument alone is a scope
  // inside the process cwd, so a lockfile outside that cwd would be skipped.
  const args =
    command === 'scan'
      ? [cli, 'scan', dir, '--offline', '--no-graph', '--no-daemon', '--quiet']
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
    expect(res.stderr).toContain('truncated or not valid syntax');
    expect(res.stderr).toContain('package manager');
    expect(res.stderr).not.toContain(secret);
    expect(res.stderr).not.toContain('left-pad');
  }, 60_000);

  it('vg build exits non-zero before parse workers stay up', () => {
    const dir = fixture();
    dirs.push(dir);
    const res = run(dir, 'build');
    expect(res.error).toBeUndefined();
    expect(res.signal).toBeNull();
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('package-lock.json');
    expect(res.stderr).toContain('truncated or not valid syntax');
    expect(res.stderr).not.toContain(secret);
  }, 60_000);
});
