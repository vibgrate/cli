import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

// Runs the Action's real "Run Vibgrate scan" script from action.yml with a stub
// `docker` on PATH, so the `max-score` validation is tested as shipped, offline.

const actionPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../action.yml');
const action = parse(readFileSync(actionPath, 'utf8')) as {
  runs: { steps: Array<{ id?: string; run?: string }> };
};
const scanScript = action.runs.steps.find((step) => step.id === 'scan')?.run ?? '';

const work = mkdtempSync(path.join(tmpdir(), 'vibgrate-action-'));
const dockerArgsFile = path.join(work, 'docker-args');
writeFileSync(path.join(work, 'docker'), `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${dockerArgsFile}"\n`);
chmodSync(path.join(work, 'docker'), 0o755);

afterAll(() => rmSync(work, { recursive: true, force: true }));

function runScan(maxScore: string) {
  rmSync(dockerArgsFile, { force: true });
  const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', scanScript], {
    cwd: work,
    encoding: 'utf8',
    env: {
      PATH: `${work}:${process.env.PATH ?? ''}`,
      GITHUB_OUTPUT: path.join(work, 'github-output'),
      IMAGE: 'ghcr.io/vibgrate/cli',
      INPUT_TAG: 'test',
      INPUT_PATH: '.',
      INPUT_FORMAT: 'sarif',
      INPUT_OUTPUT: 'vibgrate.sarif',
      INPUT_FAIL_ON: '',
      INPUT_MAX_SCORE: maxScore,
      INPUT_BASELINE: '',
      INPUT_MAX_WORSENING: '',
      INPUT_SUMMARY: 'vibgrate-summary.json',
      INPUT_VULNS: 'false',
      INPUT_ARGS: '',
      VIBGRATE_DSN: '',
    },
  });
  const dockerArgs = existsSync(dockerArgsFile) ? readFileSync(dockerArgsFile, 'utf8').split('\n') : null;
  return { status: result.status, stdout: result.stdout, dockerArgs };
}

function budgetArg(dockerArgs: string[] | null): string | undefined {
  const at = dockerArgs?.indexOf('--drift-budget') ?? -1;
  return at === -1 ? undefined : dockerArgs?.[at + 1];
}

describe('GitHub Action max-score input', () => {
  it('found the scan step in action.yml', () => {
    expect(scanScript).toContain('INPUT_MAX_SCORE');
  });

  it('runs without a score gate when max-score is empty', () => {
    const { status, dockerArgs } = runScan('');
    expect(status).toBe(0);
    expect(dockerArgs).not.toBeNull();
    expect(dockerArgs).not.toContain('--drift-budget');
  });

  it.each([
    ['0', '0'],
    ['100', '100'],
    ['42.5', '42.5'],
    [' 40 ', '40'],
  ])('passes max-score %j to --drift-budget as %j', (input, expected) => {
    const { status, dockerArgs } = runScan(input);
    expect(status).toBe(0);
    expect(budgetArg(dockerArgs)).toBe(expected);
  });

  it.each(['150', '100.5', '-1', 'abc'])('fails before the scan when max-score is %j', (input) => {
    const { status, stdout, dockerArgs } = runScan(input);
    expect(status).toBe(1);
    expect(stdout).toContain(`::error::max-score must be a number from 0 to 100 (got '${input}').`);
    expect(dockerArgs).toBeNull();
  });
});
