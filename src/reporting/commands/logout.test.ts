import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { logoutCommand } from './logout.js';
import { writeStoredCredentials, readStoredCredentials } from '../credentials.js';

const SECRET = 'b'.repeat(64);
const SAMPLE_DSN = `vibgrate+https://${'a'.repeat(24)}:${SECRET}@us.ingest.vibgrate.com/0123456789abcdef`;

describe('logout command', () => {
  let home: string;
  const prevHome = process.env.HOME;
  const prevDsn = process.env.VIBGRATE_DSN;
  let logs: string[];
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(tmpdir(), 'vibgrate-logout-'));
    process.env.HOME = home;
    delete process.env.VIBGRATE_DSN;
    logs = [];
    spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.join(' '));
    });
  });

  afterEach(() => {
    spy.mockRestore();
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevDsn === undefined) delete process.env.VIBGRATE_DSN;
    else process.env.VIBGRATE_DSN = prevDsn;
    fs.rmSync(home, { recursive: true, force: true });
  });

  // Invoke the command action directly (no args after the command name).
  const run = () => logoutCommand.parseAsync([], { from: 'user' });

  it('deletes the stored credentials file', async () => {
    writeStoredCredentials({ dsn: SAMPLE_DSN, savedAt: 'now' });
    expect(readStoredCredentials()).not.toBeNull();
    await run();
    expect(readStoredCredentials()).toBeNull();
    expect(logs.join('\n')).toContain('Logged out');
  });

  it('warns when VIBGRATE_DSN is still set, without echoing its value', async () => {
    process.env.VIBGRATE_DSN = SAMPLE_DSN;
    await run();
    const out = logs.join('\n');
    expect(out).toContain('VIBGRATE_DSN is still set');
    // The secret must never be printed (GUARDRAILS §1.1).
    expect(out).not.toContain(SAMPLE_DSN);
    expect(out).not.toContain(SECRET);
  });

  it('does not warn when VIBGRATE_DSN is not set', async () => {
    await run();
    expect(logs.join('\n')).not.toContain('VIBGRATE_DSN is still set');
  });
});
