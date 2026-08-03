import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { embedderHealth, clearEmbedderHealth, embedHealthPath, crashedMessage } from './embed-health.js';
import { VERSION } from '../version.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-embed-health-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A stubbed probe outcome. */
const probe = (r: Partial<{ signal: string | null; status: number | null; stdout: string }>) => async () => ({
  signal: r.signal ?? null,
  status: r.status ?? null,
  stdout: r.stdout ?? '',
});

/** Really run a child and report how it died — no stubbing of the mechanism. */
function realProbe(nodeScript: string) {
  return () =>
    new Promise<{ signal: string | null; status: number | null; stdout: string }>((resolve) => {
      const child = spawn(process.execPath, ['-e', nodeScript], { stdio: ['ignore', 'pipe', 'ignore'] });
      let stdout = '';
      child.stdout?.on('data', (d: Buffer) => {
        stdout += d.toString('utf8');
      });
      child.on('close', (code, signal) => resolve({ signal: signal ?? null, status: code ?? null, stdout }));
    });
}

describe('embedderHealth', () => {
  it('reports a healthy backend and remembers it', async () => {
    await expect(embedderHealth({ cacheDir: dir, runProbe: probe({ stdout: '{"ok":true}' }) })).resolves.toEqual({
      status: 'ok',
    });
    // Second call must not re-probe — a throwing runner proves the cache is used.
    const boom = () => {
      throw new Error('should not run');
    };
    await expect(embedderHealth({ cacheDir: dir, runProbe: boom })).resolves.toEqual({ status: 'ok' });
  });

  it('reports a crash, remembers it, and names the blocked postinstall', async () => {
    const health = await embedderHealth({ cacheDir: dir, runProbe: probe({ signal: 'SIGTRAP' }) });
    expect(health.status).toBe('crashed');
    if (health.status !== 'crashed') throw new Error('unreachable');
    expect(health.signal).toBe('SIGTRAP');
    expect(health.message).toMatch(/allow-scripts/);
    expect(health.message).toMatch(/onnxruntime-node/);
    expect(health.message).toMatch(/lexical/);

    // Sticky: the next call must not load the addon just because a later probe
    // would have said otherwise.
    const again = await embedderHealth({ cacheDir: dir, runProbe: probe({ stdout: '{"ok":true}' }) });
    expect(again.status).toBe('crashed');
  });

  it('treats a clean "could not load" as inconclusive, changing nothing', async () => {
    // Model not downloaded, no cache permission: the existing path reports the
    // specific reason, so this must not disable semantic.
    await expect(
      embedderHealth({ cacheDir: dir, runProbe: probe({ stdout: '{"ok":false}', status: 0 }) }),
    ).resolves.toEqual({ status: 'unknown' });
    expect(fs.existsSync(embedHealthPath(dir))).toBe(false);
  });

  it('treats its own timeout (SIGTERM) as inconclusive, not a crash', async () => {
    await expect(embedderHealth({ cacheDir: dir, runProbe: probe({ signal: 'SIGTERM' }) })).resolves.toEqual({
      status: 'unknown',
    });
    expect(fs.existsSync(embedHealthPath(dir))).toBe(false);
  });

  it('is inconclusive when the probe cannot even be spawned', async () => {
    await expect(
      embedderHealth({
        cacheDir: dir,
        runProbe: () => {
          throw new Error('EAGAIN');
        },
      }),
    ).resolves.toEqual({ status: 'unknown' });
  });

  it('re-probes after the verdict is cleared (the fix-your-install path)', async () => {
    await embedderHealth({ cacheDir: dir, runProbe: probe({ signal: 'SIGTRAP' }) });
    clearEmbedderHealth(dir);
    await expect(embedderHealth({ cacheDir: dir, runProbe: probe({ stdout: '{"ok":true}' }) })).resolves.toEqual({
      status: 'ok',
    });
  });

  it('re-probes on force even with a stored verdict', async () => {
    await embedderHealth({ cacheDir: dir, runProbe: probe({ stdout: '{"ok":true}' }) });
    const health = await embedderHealth({ cacheDir: dir, force: true, runProbe: probe({ signal: 'SIGTRAP' }) });
    expect(health.status).toBe('crashed');
  });

  it('survives a corrupt verdict file by re-probing', async () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(embedHealthPath(dir), 'not json', 'utf8');
    await expect(embedderHealth({ cacheDir: dir, runProbe: probe({ stdout: '{"ok":true}' }) })).resolves.toEqual({
      status: 'ok',
    });
  });
});

describe('the probe mechanism against a really crashing child', () => {
  // The whole point is surviving a process death that no try/catch can catch,
  // so prove it against an actual signal rather than only a stubbed result.
  it('detects a child killed by a signal and keeps this process alive', async () => {
    const health = await embedderHealth({
      cacheDir: dir,
      runProbe: realProbe('process.kill(process.pid, "SIGTRAP")'),
    });
    expect(health.status).toBe('crashed');
    if (health.status !== 'crashed') throw new Error('unreachable');
    expect(health.signal).toBe('SIGTRAP');
  });

  it('detects a clean child that simply reports it could not load', async () => {
    const health = await embedderHealth({
      cacheDir: dir,
      runProbe: realProbe('process.stdout.write(\'{"ok":false}\')'),
    });
    expect(health.status).toBe('unknown');
  });

  it('detects a healthy child end to end', async () => {
    const health = await embedderHealth({
      cacheDir: dir,
      runProbe: realProbe('process.stdout.write(\'{"ok":true}\')'),
    });
    expect(health.status).toBe('ok');
  });
});

describe('a new install or upgrade earns a fresh probe', () => {
  it('ignores a verdict stamped with a different CLI version', async () => {
    await embedderHealth({ cacheDir: dir, runProbe: probe({ signal: 'SIGTRAP' }) });
    const stored = JSON.parse(fs.readFileSync(embedHealthPath(dir), 'utf8')) as { version?: string };
    expect(stored.version).toBe(VERSION);

    // Simulate the upgrade: same file, older build.
    fs.writeFileSync(
      embedHealthPath(dir),
      JSON.stringify({ ...stored, version: '0.0.0-old' }),
      'utf8',
    );
    await expect(embedderHealth({ cacheDir: dir, runProbe: probe({ stdout: '{"ok":true}' }) })).resolves.toEqual({
      status: 'ok',
    });
  });

  it('ignores a verdict with no version at all (written before this existed)', async () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(embedHealthPath(dir), JSON.stringify({ status: 'crashed', signal: 'SIGTRAP', at: 'x' }), 'utf8');
    await expect(embedderHealth({ cacheDir: dir, runProbe: probe({ stdout: '{"ok":true}' }) })).resolves.toEqual({
      status: 'ok',
    });
  });

  it('deleting the verdict is what a same-version reinstall does (postinstall)', async () => {
    // `npm install -g --allow-scripts=… @vibgrate/cli` at the SAME version is
    // the exact fix for a blocked postinstall, and the version stamp alone
    // would not notice it — so postinstall removes the file.
    await embedderHealth({ cacheDir: dir, runProbe: probe({ signal: 'SIGTRAP' }) });
    expect(fs.existsSync(embedHealthPath(dir))).toBe(true);
    fs.rmSync(embedHealthPath(dir), { force: true });
    await expect(embedderHealth({ cacheDir: dir, runProbe: probe({ stdout: '{"ok":true}' }) })).resolves.toEqual({
      status: 'ok',
    });
  });
});

describe('crashedMessage', () => {
  it('is actionable: what broke, why, and the exact command that fixes it', () => {
    const m = crashedMessage('SIGTRAP');
    expect(m).toMatch(/SIGTRAP/);
    expect(m).toMatch(/npm install -g --allow-scripts=/);
    expect(m).toMatch(/--local/);
  });
});
