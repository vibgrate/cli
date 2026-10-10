import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, afterEach } from 'vitest';
import { ResourceLimitError } from './limits.js';
import { ParseWorkerError, toParseWorkerError } from './pool.js';
import {
  PARSE_INTERRUPTED_MESSAGE,
  PARSE_TERMINATED_MESSAGE,
  ParsePoolGuard,
  type ManagedPool,
  type PoolGuardHost,
  type PoolThread,
} from './pool-guard.js';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixture = path.join(pkgRoot, 'src/engine/pool-teardown.fixture.ts');

function fakeThread(): PoolThread & { terminated: number; unrefed: number } {
  const thread = {
    terminated: 0,
    unrefed: 0,
    terminate(): Promise<number> {
      thread.terminated += 1;
      return Promise.resolve(0);
    },
    unref(): void {
      thread.unrefed += 1;
    },
  };
  return thread;
}

function fakeHost(): PoolGuardHost & {
  emit(signal: NodeJS.Signals): void;
  callExit(code?: number): void;
  fireBeforeExit(): void;
  exits: number[];
  errors: string[];
  listenerCount(signal: NodeJS.Signals): number;
} {
  const listeners = new Map<NodeJS.Signals, Array<() => void>>();
  const exits: number[] = [];
  const errors: string[] = [];
  let onExit: ((code?: number) => void) | null = null;
  let beforeExit: (() => void) | null = null;
  return {
    exits,
    errors,
    prependListener(signal, listener) {
      const list = listeners.get(signal) ?? [];
      list.unshift(listener);
      listeners.set(signal, list);
    },
    removeListener(signal, listener) {
      listeners.set(
        signal,
        (listeners.get(signal) ?? []).filter((item) => item !== listener),
      );
    },
    onBeforeExit(listener) {
      beforeExit = listener;
      return () => {
        if (beforeExit === listener) beforeExit = null;
      };
    },
    installExit(handler) {
      onExit = handler;
      return () => {
        onExit = null;
      };
    },
    exit(code) {
      exits.push(code);
    },
    writeError(message) {
      errors.push(message);
    },
    emit(signal) {
      for (const listener of [...(listeners.get(signal) ?? [])]) listener();
    },
    callExit(code) {
      onExit?.(code);
    },
    fireBeforeExit() {
      beforeExit?.();
    },
    listenerCount(signal) {
      return listeners.get(signal)?.length ?? 0;
    },
  };
}

function livePool(thread: PoolThread, destroy: () => Promise<void>): ManagedPool & { cancelled: number } {
  const pool = {
    cancelled: 0,
    threads: [thread],
    cancelPendingTasks() {
      pool.cancelled += 1;
    },
    destroy,
  };
  return pool;
}

describe('parse worker errors stay actionable', () => {
  it('turns an out-of-memory worker into a resource error that says how to re-run', () => {
    const err = toParseWorkerError(
      Object.assign(new Error('JavaScript heap out of memory'), { code: 'ERR_WORKER_OUT_OF_MEMORY' }),
      256,
    );
    expect(err).toBeInstanceOf(ResourceLimitError);
    expect(err.message).toContain('256');
    expect(err.message).toContain('VG_WORKER_HEAP_MB');
    expect(err.message).toContain('--jobs 1');
    expect(err.message).toContain('--exclude');
  });

  it('keeps an existing resource error and wraps other failures without file paths', () => {
    const existing = new ResourceLimitError('already actionable');
    expect(toParseWorkerError(existing)).toBe(existing);

    const wrapped = toParseWorkerError(new Error('boom-parse at /home/dev/repo/src/app.ts\nstack'));
    expect(wrapped).toBeInstanceOf(ParseWorkerError);
    expect(wrapped.message).toContain('boom-parse');
    expect(wrapped.message).toContain('--jobs 1');
    expect(wrapped.message).toContain('--exclude');
    expect(wrapped.message).not.toContain('/home/dev');
    expect(wrapped.message).not.toContain('\n');
  });
});

describe('parse pool guard', () => {
  it('stops the pool after a normal run and drops its signal handlers', async () => {
    const host = fakeHost();
    const guard = new ParsePoolGuard(host, 30);
    const thread = fakeThread();
    let destroyed = 0;
    const pool = livePool(thread, async () => {
      destroyed += 1;
    });
    await expect(guard.using(pool, async () => 'ok')).resolves.toBe('ok');
    expect(destroyed).toBe(1);
    expect(thread.terminated).toBeGreaterThan(0);
    expect(host.exits).toEqual([]);
    expect(host.listenerCount('SIGINT')).toBe(0);
    expect(host.listenerCount('SIGTERM')).toBe(0);
  });

  it('stops the pool when the run fails and still throws the original error', async () => {
    const host = fakeHost();
    const guard = new ParsePoolGuard(host, 30);
    const thread = fakeThread();
    let destroyed = 0;
    const pool = livePool(thread, async () => {
      destroyed += 1;
    });
    const err = new Error('keep-me');
    await expect(
      guard.using(pool, async () => {
        throw err;
      }),
    ).rejects.toBe(err);
    expect(destroyed).toBe(1);
    expect(thread.terminated).toBeGreaterThan(0);
    expect(host.exits).toEqual([]);
    expect(host.errors).toEqual([]);
  });

  it('stops threads when destroy never settles', async () => {
    const host = fakeHost();
    const guard = new ParsePoolGuard(host, 40);
    const thread = fakeThread();
    const pool = livePool(thread, () => new Promise(() => undefined));
    await expect(guard.using(pool, async () => 7)).resolves.toBe(7);
    expect(pool.cancelled).toBe(1);
    expect(thread.terminated).toBeGreaterThan(0);
    expect(thread.unrefed).toBeGreaterThan(0);
    expect(host.listenerCount('SIGINT')).toBe(0);
  });

  it('tears the pool down on SIGINT and exits 130 with an actionable line', async () => {
    const host = fakeHost();
    const guard = new ParsePoolGuard(host, 40);
    const thread = fakeThread();
    const pool = livePool(thread, () => new Promise(() => undefined));
    void guard.using(pool, () => new Promise(() => undefined));
    await new Promise((resolve) => setTimeout(resolve, 0));
    host.emit('SIGINT');
    host.emit('SIGINT');
    await waitFor(() => host.exits.length > 0);
    expect(host.exits).toEqual([130]);
    expect(host.errors).toEqual([`error: ${PARSE_INTERRUPTED_MESSAGE}\n`]);
    expect(pool.cancelled).toBe(1);
    expect(thread.terminated).toBeGreaterThan(0);
    expect(host.listenerCount('SIGINT')).toBe(0);
  });

  it('tears the pool down on SIGTERM and exits 143', async () => {
    const host = fakeHost();
    const guard = new ParsePoolGuard(host, 40);
    const thread = fakeThread();
    const pool = livePool(thread, async () => undefined);
    void guard.using(pool, () => new Promise(() => undefined));
    await new Promise((resolve) => setTimeout(resolve, 0));
    host.emit('SIGTERM');
    await waitFor(() => host.exits.length > 0);
    expect(host.exits).toEqual([143]);
    expect(host.errors[0]).toContain(PARSE_TERMINATED_MESSAGE);
  });

  it('stops the pool when the process exits and does not add an interrupt line', async () => {
    const host = fakeHost();
    const guard = new ParsePoolGuard(host, 40);
    const thread = fakeThread();
    const pool = livePool(thread, async () => undefined);
    void guard.using(pool, () => new Promise(() => undefined));
    await new Promise((resolve) => setTimeout(resolve, 0));
    host.callExit(1);
    await waitFor(() => host.exits.length > 0);
    expect(host.exits).toEqual([1]);
    expect(host.errors).toEqual([]);
    expect(thread.terminated).toBeGreaterThan(0);
    expect(guard.isExiting).toBe(true);
  });

  it('stops a pool that is still tracked when the event loop would drain', async () => {
    const host = fakeHost();
    const guard = new ParsePoolGuard(host, 40);
    const thread = fakeThread();
    let destroyed = 0;
    const pool = livePool(thread, async () => {
      destroyed += 1;
    });
    guard.track(pool);
    host.fireBeforeExit();
    await waitFor(() => destroyed === 1 && thread.terminated > 0);
    expect(thread.terminated).toBeGreaterThan(0);
    expect(host.listenerCount('SIGINT')).toBe(0);
  });
});

describe('parse pool process teardown', () => {
  const children: ChildProcess[] = [];
  const dirs: string[] = [];

  afterEach(() => {
    for (const child of children) {
      if (child.pid && child.exitCode === null && !child.killed) {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }
    }
    children.length = 0;
    while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it('stops real workers on success, failure, and SIGINT', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-pool-'));
    dirs.push(dir);
    const worker = path.join(dir, 'worker.mjs');
    fs.writeFileSync(
      worker,
      [
        "import * as fs from 'node:fs';",
        'export default async function run() {',
        '  const mode = process.env.VG_POOL_TEST_MODE;',
        "  if (mode === 'hang') {",
        '    const ready = process.env.VG_POOL_READY;',
        "    if (ready) fs.writeFileSync(ready, 'ready');",
        '    const stamp = process.env.VG_POOL_HEARTBEAT;',
        '    if (stamp) {',
        '      const beat = () => { try { fs.writeFileSync(stamp, String(Date.now())); } catch { /* parent left */ } };',
        '      beat();',
        '      setInterval(beat, 40);',
        '    }',
        '    await new Promise(() => undefined);',
        '  }',
        "  if (mode === 'fail') throw new Error('boom-parse');",
        '  return [];',
        '}',
        '',
      ].join('\n'),
    );

    const ok = await runMode(worker, 'ok');
    expect(ok.code).toBe(0);
    expect(ok.stderr).not.toContain('error:');
    expect(alive(ok.pid)).toBe(false);

    const failed = await runMode(worker, 'fail');
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain('boom-parse');
    expect(failed.stderr).toContain('--jobs 1');
    expect(failed.stderr).toContain('--exclude');
    expect(failed.stderr).not.toContain(dir);
    expect(alive(failed.pid)).toBe(false);

    const heartbeat = path.join(dir, 'beat');
    const ready = path.join(dir, 'ready');
    const interrupted = await runMode(worker, 'hang', heartbeat, ready);
    expect(interrupted.code).toBe(130);
    expect(interrupted.stderr).toContain(PARSE_INTERRUPTED_MESSAGE);
    expect(interrupted.stderr).not.toContain('Terminating worker thread');
    expect(alive(interrupted.pid)).toBe(false);
    const stamped = fs.readFileSync(heartbeat, 'utf8');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(fs.readFileSync(heartbeat, 'utf8')).toBe(stamped);
  }, 40_000);

  async function runMode(
    worker: string,
    mode: 'ok' | 'fail' | 'hang',
    heartbeat?: string,
    readyFile?: string,
  ): Promise<{ code: number; stderr: string; pid: number }> {
    const child = spawn(process.execPath, ['--import', 'tsx', fixture, mode, worker], {
      cwd: pkgRoot,
      env: {
        ...process.env,
        NO_COLOR: '1',
        VG_POOL_TEST_MODE: mode,
        ...(heartbeat ? { VG_POOL_HEARTBEAT: heartbeat } : {}),
        ...(readyFile ? { VG_POOL_READY: readyFile } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    const pid = child.pid;
    if (!pid) throw new Error('parse pool fixture failed to start');
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.stdout?.on('data', () => undefined);
    const exited = waitExit(child, 20_000);
    if (mode === 'hang') {
      await waitFor(() => (readyFile ? fs.existsSync(readyFile) : false), 20_000);
      child.kill('SIGINT');
    }
    const code = await exited;
    return { code, stderr, pid };
  }
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function waitExit(child: ChildProcess, ms: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('parse pool fixture did not exit'));
    }, ms);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (signal === 'SIGINT') resolve(130);
      else if (signal) reject(new Error(`fixture died on ${signal}`));
      else resolve(code ?? 1);
    });
  });
}

async function waitFor(pred: () => boolean, ms = 2_000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting for parse pool teardown');
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}
