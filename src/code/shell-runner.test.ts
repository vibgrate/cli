import { describe, it, expect } from 'vitest';
import { runShellAsync } from './shell-runner.js';

describe('runShellAsync', () => {
  it('streams stdout chunks and returns exit 0', async () => {
    const chunks: string[] = [];
    const res = await runShellAsync('printf hello', {
      cwd: process.cwd(),
      onChunk: (c) => chunks.push(c),
      timeoutMs: 10_000,
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('hello');
    expect(chunks.join('')).toContain('hello');
  });

  it('times out long commands', async () => {
    const res = await runShellAsync('sleep 5', {
      cwd: process.cwd(),
      timeoutMs: 200,
    });
    expect(res.timedOut).toBe(true);
    expect(res.exitCode).toBe(124);
  }, 15_000);
});
