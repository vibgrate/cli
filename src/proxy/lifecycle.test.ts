import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { daemonArgv, ensureProxyRunning } from './lifecycle.js';

/**
 * The detached listener is started by spawning the CLI again. The argv it is
 * spawned with used to name a verb (`vg proxy --background`) that was later
 * retired: the child exited 5 with a "has moved" usage error before it ever
 * bound, so `vg serve --compress <agent>` could never start its own
 * listener. These tests pin the spawn contract from the spawner's side;
 * `serve-compress.test.ts` parses the same argv through `vg serve`.
 */

function tempEnv(): NodeJS.ProcessEnv {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-lifecycle-'));
  return { VG_CONTEXT_DIR: path.join(dir, 'ctx'), VG_CONTEXT_RUNTIME_DIR: path.join(dir, 'run'), HOME: dir };
}

class FakeChild extends EventEmitter {
  pid = 777;
  exitCode: number | null = null;
  unref(): void {}
}

describe('daemonArgv', () => {
  it('spawns the listener as `vg serve --compress-only --compress-daemon`, never a retired verb', () => {
    const argv = daemonArgv(8787, ['--profile', 'aggressive']);
    expect(argv).toEqual(['serve', '--compress-only', '--compress-daemon', '--compress-port', '8787', '--quiet', '--profile', 'aggressive']);
    expect(argv[0]).not.toBe('proxy');
    expect(argv).not.toContain('--background');
  });
});

describe('ensureProxyRunning', () => {
  it('reuses a healthy listener without spawning anything', async () => {
    const env = tempEnv();
    let spawned = 0;
    const fetchFn: typeof globalThis.fetch = async () => new Response(JSON.stringify({ service: 'vg-proxy', version: '1', pid: 41 }), { status: 200 });
    const r = await ensureProxyRunning({ port: 8790, env, fetch: fetchFn, spawn: (() => {
      spawned++;
      return new FakeChild() as never;
    }) as never, sleep: async () => {} });
    expect(spawned).toBe(0);
    expect(r).toMatchObject({ url: 'http://127.0.0.1:8790', port: 8790, started: false, pid: 41 });
  });

  it('spawns the daemon argv with the bind host and upstream pins in its environment, then waits for /health', async () => {
    const env = { ...tempEnv(), VG_PROXY_OPENAI_API_URL: 'https://api.x.ai' };
    const spawnCalls: Array<{ cmd: string; args: string[]; opts: { detached?: boolean; stdio?: string; env?: NodeJS.ProcessEnv } }> = [];
    const fetchFn: typeof globalThis.fetch = async () => {
      // Down until the child has been spawned, then healthy.
      if (!spawnCalls.length) return new Response('nope', { status: 503 });
      return new Response(JSON.stringify({ service: 'vg-proxy', version: '1', pid: 900 }), { status: 200 });
    };
    const spawn = ((cmd: string, args: string[], opts: { detached?: boolean; stdio?: string; env?: NodeJS.ProcessEnv }) => {
      spawnCalls.push({ cmd, args, opts });
      return new FakeChild() as never;
    }) as never;
    const r = await ensureProxyRunning({ port: 8791, host: '127.0.0.1', env, fetch: fetchFn, spawn, sleep: async () => {}, execPath: '/usr/bin/node', script: '/opt/vg/dist/cli.js', spawnArgs: ['--profile', 'coding'] });
    expect(r.started).toBe(true);
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]!.cmd).toBe('/usr/bin/node');
    expect(spawnCalls[0]!.args).toEqual(['/opt/vg/dist/cli.js', ...daemonArgv(8791, ['--profile', 'coding'])]);
    expect(spawnCalls[0]!.opts).toMatchObject({ detached: true, stdio: 'ignore' });
    expect(spawnCalls[0]!.opts.env).toMatchObject({ VG_PROXY_HOST: '127.0.0.1', VG_PROXY_PORT: '8791', VG_PROXY_OPENAI_API_URL: 'https://api.x.ai' });
  });

  it('reports a daemon that exits before binding instead of waiting out the timeout', async () => {
    const env = tempEnv();
    const fetchFn: typeof globalThis.fetch = async () => new Response('nope', { status: 503 });
    const spawn = (() => {
      const child = new FakeChild();
      child.exitCode = 5; // what the retired `vg proxy` verb produced
      return child as never;
    }) as never;
    let now = 0;
    await expect(ensureProxyRunning({ port: 8792, env, fetch: fetchFn, spawn, sleep: async () => {}, now: () => (now += 200), timeoutMs: 5000, script: '/x/cli.js' })).rejects.toThrow(/exited with code 5 before becoming ready/);
  });
});
