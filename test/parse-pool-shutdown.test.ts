import { createRequire } from 'node:module';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { DiscoveredFile } from '../src/engine/discover.js';
import { parseFiles, activeParseWorkerCount } from '../src/engine/pool.js';

const require = createRequire(import.meta.url);
const tsx = require.resolve('tsx/cli');
const here = path.dirname(fileURLToPath(import.meta.url));
const harness = path.join(here, 'fixtures/parse-pool-harness.ts');
const workerFile = path.join(here, 'fixtures/parse-pool-worker.mjs');

interface ProcRow {
  pid: number;
  ppid: number;
  stat: string;
  args: string;
}

function listProcesses(): ProcRow[] {
  const out = spawnSync('ps', ['-eo', 'pid,ppid,stat,args'], { encoding: 'utf8' });
  const rows: ProcRow[] = [];
  for (const line of (out.stdout || '').split('\n').slice(1)) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!match) continue;
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), stat: match[3], args: match[4] });
  }
  return rows;
}

function isWorkerProc(row: ProcRow): boolean {
  if (row.stat.includes('Z')) return false;
  return row.args.includes('entry/process.js') || row.args.includes('parse-pool-worker.mjs');
}

function workerPids(): Set<number> {
  return new Set(listProcesses().filter(isWorkerProc).map((row) => row.pid));
}

function descendants(pid: number): number[] {
  const rows = listProcesses();
  const out: number[] = [];
  const queue = [pid];
  const seen = new Set<number>([pid]);
  while (queue.length) {
    const cur = queue.pop();
    if (cur === undefined) break;
    for (const row of rows) {
      if (row.ppid === cur && !seen.has(row.pid) && !row.stat.includes('Z')) {
        seen.add(row.pid);
        out.push(row.pid);
        queue.push(row.pid);
      }
    }
  }
  return out;
}

function isAlive(pid: number): boolean {
  const row = listProcesses().find((item) => item.pid === pid);
  if (!row || row.stat.includes('Z')) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Running {
  child: ChildProcess;
  output: { stdout: string; stderr: string };
}

function startHarness(mode: string, runtime: 'worker_threads' | 'child_process'): Running {
  const child = spawn(process.execPath, [tsx, harness, mode, runtime], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NO_COLOR: '1',
      FORCE_COLOR: '0',
      VIBGRATE_NO_KERNEL: '1',
    },
  });
  const output = { stdout: '', stderr: '' };
  child.stdout?.on('data', (chunk: Buffer) => {
    output.stdout += chunk.toString('utf8');
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    output.stderr += chunk.toString('utf8');
  });
  return { child, output };
}

function waitExit(
  running: Running,
  timeoutMs = 15_000,
): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  const { child, output } = running;
  return new Promise((resolve, reject) => {
    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      resolve({ code, signal, stdout: output.stdout, stderr: output.stderr });
    };
    if (child.exitCode !== null || child.signalCode !== null) {
      setImmediate(() => finish(child.exitCode, child.signalCode));
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`harness timed out\nstdout:\n${output.stdout}\nstderr:\n${output.stderr}`));
    }, timeoutMs);
    child.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      // The signal path writes stderr and then exits; give the pipe a moment.
      setTimeout(() => finish(code, signal), 100);
    });
  });
}

async function waitForStdout(running: Running, needle: string): Promise<void> {
  const started = Date.now();
  while (!running.output.stdout.includes(needle)) {
    if (Date.now() - started > 10_000) {
      throw new Error(`timed out waiting for ${needle}\nstdout:\n${running.output.stdout}\nstderr:\n${running.output.stderr}`);
    }
    const { child } = running;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `harness exited before ${needle} (code ${child.exitCode} signal ${child.signalCode})\n${running.output.stderr}`,
      );
    }
    await delay(30);
  }
}

const files: DiscoveredFile[] = ['b.ts', 'a.ts'].map((rel) => ({
  rel,
  abs: rel,
  lang: { id: 'ts' } as DiscoveredFile['lang'],
}));

describe('parse worker shutdown', () => {
  it('keeps pooled parse output ordered and stable', async () => {
    delete process.env.VG_POOL_WORKER_MODE;
    const opts = { jobs: 2, workerFile, memoryBudgetMb: 0 as const };
    const once = await parseFiles(files, opts);
    const twice = await parseFiles(files, opts);
    expect(once.map((row) => row.rel)).toEqual(['a.ts', 'b.ts']);
    expect(JSON.stringify(once)).toBe(JSON.stringify(twice));
    expect(activeParseWorkerCount()).toBe(0);
  });

  it('a memory-budget failure during parse exits the pool', async () => {
    delete process.env.VG_POOL_WORKER_MODE;
    const run = parseFiles(files, { jobs: 2, workerFile, memoryBudgetMb: 1 });
    const timeout = new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error('parse hung after a budget failure')), 8_000);
    });
    await expect(Promise.race([run, timeout])).rejects.toThrow(/VG_MEMORY_BUDGET_MB/);
    expect(activeParseWorkerCount()).toBe(0);
  });

  it.each(['worker_threads', 'child_process'] as const)(
    'a finished %s pool exits and leaves no workers',
    async (runtime) => {
      const before = workerPids();
      const running = startHarness('ok', runtime);
      const result = await waitExit(running);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('OK');
      expect(result.stderr).not.toContain('removeListener');
      await delay(200);
      const leaked = [...workerPids()].filter((pid) => !before.has(pid) && isAlive(pid));
      expect(leaked).toEqual([]);
    },
  );

  it.each(['worker_threads', 'child_process'] as const)(
    'a crashing %s worker exits with an actionable error and leaves no workers',
    async (runtime) => {
      const before = workerPids();
      const running = startHarness('crash', runtime);
      const result = await waitExit(running);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('graph build stopped: a parse worker failed');
      expect(result.stderr).toContain('--jobs 1');
      expect(result.stderr).toContain('--exclude');
      expect(result.stderr).toContain('VG_WORKER_HEAP_MB');
      expect(result.stderr).not.toContain('removeListener');
      // worker_threads share the parent's stderr. A shutdown bug prints a
      // `removeListener` stack from node:internal; the actionable line must
      // be the whole failure. child_process workers print their own crash
      // before exiting — that text is the worker, and the parent must still
      // exit and reap it.
      if (runtime === 'worker_threads') {
        expect(result.stderr).not.toContain('node:internal');
        expect(result.stderr).not.toMatch(/\n\s+at /);
      }
      await delay(300);
      const leaked = [...workerPids()].filter((pid) => !before.has(pid) && isAlive(pid));
      expect(leaked).toEqual([]);
      expect(isAlive(running.child.pid ?? -1)).toBe(false);
    },
  );

  it.each([
    ['worker_threads', 'SIGTERM', 143, 'terminated while parsing'],
    ['child_process', 'SIGTERM', 143, 'terminated while parsing'],
    ['child_process', 'SIGINT', 130, 'interrupted while parsing'],
  ] as const)(
    'a hung %s pool stops workers on %s',
    async (runtime, signal, code, message) => {
      const before = workerPids();
      const running = startHarness('hang', runtime);
      await waitForStdout(running, 'READY');
      let kids: number[] = [];
      if (runtime === 'child_process') {
        const started = Date.now();
        while (kids.length === 0 && Date.now() - started < 5_000) {
          kids = descendants(running.child.pid ?? -1);
          if (kids.length === 0) await delay(50);
        }
        expect(kids.length).toBeGreaterThan(0);
      }
      running.child.kill(signal);
      const result = await waitExit(running);
      expect(result.signal).toBeNull();
      expect(result.code).toBe(code);
      expect(result.stderr).toContain(message);
      expect(result.stderr).not.toContain('removeListener');
      expect(result.stderr).not.toMatch(/\n\s+at /);
      await delay(300);
      const still = kids.filter((pid) => isAlive(pid));
      expect(still).toEqual([]);
      const leaked = [...workerPids()].filter((pid) => !before.has(pid) && isAlive(pid));
      expect(leaked).toEqual([]);
      expect(isAlive(running.child.pid ?? -1)).toBe(false);
    },
  );
});
