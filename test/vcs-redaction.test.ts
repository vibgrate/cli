import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { detectVcs, redactUrlCredentials } from '../src/core-open/utils/vcs.js';
import { makeProject, cleanup } from './helpers.js';

/**
 * GUARDRAILS §1: credentials must be redacted at ingest. CI clones commonly
 * embed a token in the origin URL; the scan artifact (and `vg push`) must never
 * carry it.
 */

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) cleanup(dirs.pop()!);
});

function gitProject(remoteUrl: string): string {
  const d = makeProject({ 'a.ts': 'export const a = 1;' });
  dirs.push(d);
  fs.mkdirSync(path.join(d, '.git', 'refs', 'heads'), { recursive: true });
  fs.writeFileSync(path.join(d, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  fs.writeFileSync(
    path.join(d, '.git', 'config'),
    `[remote "origin"]\n\turl = ${remoteUrl}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`,
  );
  return d;
}

describe('scan VCS capture redacts credentials', () => {
  it('strips user:token userinfo from the origin URL', async () => {
    const root = gitProject('https://ci-bot:ghp_secret123@github.com/acme/private.git');
    const vcs = await detectVcs(root);
    expect(vcs.remoteUrl).toBe('https://github.com/acme/private.git');
    expect(JSON.stringify(vcs)).not.toContain('ghp_secret123');
  });

  it('leaves credential-free URLs untouched', async () => {
    const root = gitProject('git@github.com:acme/app.git');
    const vcs = await detectVcs(root);
    expect(vcs.remoteUrl).toBe('git@github.com:acme/app.git');
  });
});

describe('redactUrlCredentials', () => {
  it('handles user-only and user:token forms', () => {
    expect(redactUrlCredentials('https://u@h/p')).toBe('https://h/p');
    expect(redactUrlCredentials('https://u:t@h/p')).toBe('https://h/p');
    expect(redactUrlCredentials('https://h/p')).toBe('https://h/p');
  });
});
