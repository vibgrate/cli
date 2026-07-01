import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { gitHistoryAvailable, fileCommits } from '../src/core-open/utils/git-history.js';
import { buildVersionTimelines } from '../src/core-open/utils/version-timeline.js';

// Smoke test for the vendored git-history module. The authoritative unit suite
// lives in @vibgrate/core-open (src/utils/git-history.test.ts); this guards the
// copy that actually ships in @vibgrate/cli so a bad vendor can't slip through.

function gitInstalled(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const HAS_GIT = gitInstalled();
const IDENTITY = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

function git(cwd: string, args: string[], date?: string): void {
  execFileSync('git', args, {
    cwd,
    stdio: 'pipe',
    env: { ...process.env, ...IDENTITY, ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}) },
  });
}

async function commit(dir: string, file: string, content: string, message: string, date: string): Promise<void> {
  await fs.writeFile(path.join(dir, file), content);
  git(dir, ['add', file]);
  git(dir, ['commit', '-m', message], date);
}

function npmLock(deps: Record<string, string>): string {
  const packages: Record<string, unknown> = { '': { name: 'fixture' } };
  for (const [name, version] of Object.entries(deps)) packages[`node_modules/${name}`] = { version };
  return JSON.stringify({ lockfileVersion: 3, packages });
}

describe.skipIf(!HAS_GIT)('vendored git-history (shipped copy)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(tmpdir(), 'vg-vendored-githist-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('degrades gracefully outside a repo', async () => {
    expect(await gitHistoryAvailable(dir)).toBe(false);
    expect(await buildVersionTimelines(dir)).toBeNull();
  });

  it('builds an npm version timeline with commit attribution', async () => {
    git(dir, ['init', '-b', 'main']);
    git(dir, ['config', 'commit.gpgsign', 'false']);
    await commit(dir, 'package-lock.json', npmLock({ lodash: '4.17.20' }), 'add lodash', '2021-01-01T00:00:00Z');
    await commit(dir, 'package-lock.json', npmLock({ lodash: '4.17.21' }), 'bump lodash', '2021-02-01T00:00:00Z');

    expect((await fileCommits(dir, 'package-lock.json')).map((c) => c.subject)).toEqual(['add lodash', 'bump lodash']);

    const timelines = await buildVersionTimelines(dir);
    const lodash = timelines?.ecosystems[0].packages.find((p) => p.name === 'lodash');
    expect(lodash?.changes.map((c) => c.version)).toEqual(['4.17.20', '4.17.21']);
    expect(lodash?.changes[0].commit.authorName).toBe('Test');
  });
});
