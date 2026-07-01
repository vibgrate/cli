import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import {
  clearStoredCredentials,
  credentialsPath,
  gitignoreEntryForCredentials,
  readStoredCredentials,
  resolveDsn,
  writeStoredCredentials,
} from './credentials.js';

const SAMPLE_DSN = `vibgrate+https://${'a'.repeat(24)}:${'b'.repeat(64)}@us.ingest.vibgrate.com/0123456789abcdef`;

describe('credentials store', () => {
  let home: string;
  const prevHome = process.env.HOME;
  const prevDsn = process.env.VIBGRATE_DSN;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(tmpdir(), 'vibgrate-home-'));
    process.env.HOME = home;
    delete process.env.VIBGRATE_DSN;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevDsn === undefined) delete process.env.VIBGRATE_DSN;
    else process.env.VIBGRATE_DSN = prevDsn;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('writes and reads stored credentials under ~/.vibgrate', () => {
    expect(readStoredCredentials()).toBeNull();
    writeStoredCredentials({ dsn: SAMPLE_DSN, workspaceId: '0123456789abcdef', savedAt: 'now' });
    expect(credentialsPath().startsWith(home)).toBe(true);
    expect(readStoredCredentials()?.dsn).toBe(SAMPLE_DSN);
  });

  it('clears stored credentials', () => {
    writeStoredCredentials({ dsn: SAMPLE_DSN, savedAt: 'now' });
    expect(clearStoredCredentials()).toBe(true);
    expect(readStoredCredentials()).toBeNull();
    // clearing again is a no-op
    expect(clearStoredCredentials()).toBe(false);
  });

  it('resolveDsn precedence: flag > env > stored', () => {
    writeStoredCredentials({ dsn: 'STORED', savedAt: 'now' });
    expect(resolveDsn('FLAG')).toBe('FLAG');

    process.env.VIBGRATE_DSN = 'ENV';
    expect(resolveDsn()).toBe('ENV');
    expect(resolveDsn('FLAG')).toBe('FLAG');

    delete process.env.VIBGRATE_DSN;
    expect(resolveDsn()).toBe('STORED');
  });

  it('returns undefined when nothing is configured', () => {
    expect(resolveDsn()).toBeUndefined();
  });

  it('ignores a corrupt credentials file', () => {
    fs.mkdirSync(path.dirname(credentialsPath()), { recursive: true });
    fs.writeFileSync(credentialsPath(), 'not json', 'utf8');
    expect(readStoredCredentials()).toBeNull();
  });

  it('derives a repo-relative .gitignore entry when creds live in the repo', () => {
    // With HOME pointed at the repo root, the credentials file is inside it.
    expect(gitignoreEntryForCredentials(home)).toBe('.vibgrate/credentials.json');
  });

  it('falls back to the conventional path when creds are outside the repo', () => {
    const repo = fs.mkdtempSync(path.join(tmpdir(), 'vibgrate-repo-'));
    try {
      // creds live under $HOME, which is a different tree than `repo`.
      expect(gitignoreEntryForCredentials(repo)).toBe('.vibgrate/credentials.json');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
