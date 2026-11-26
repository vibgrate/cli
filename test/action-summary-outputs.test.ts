import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

// Runs the Action's real "summary" step script from action.yml against a
// hand-written summary JSON, so the drift-score / risk-level / score-delta
// outputs are tested as shipped, offline. PATH is built explicitly for every
// run: a directory holding only a `jq` symlink, or an empty one for the no-jq
// case, so the result does not depend on what the runner has installed.

const actionPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../action.yml');
const action = parse(readFileSync(actionPath, 'utf8')) as {
  runs: { steps: Array<{ id?: string; run?: string }> };
};
const summaryScript = action.runs.steps.find((step) => step.id === 'summary')?.run ?? '';

function which(bin: string): string | null {
  const found = spawnSync('bash', ['-c', `command -v ${bin}`], { encoding: 'utf8' });
  return found.status === 0 ? found.stdout.trim() : null;
}
const bashPath = which('bash') ?? 'bash';
const jqPath = which('jq');

const work = mkdtempSync(path.join(tmpdir(), 'vibgrate-action-summary-'));
const withJq = path.join(work, 'bin-jq');
const withoutJq = path.join(work, 'bin-empty');
mkdirSync(withJq);
mkdirSync(withoutJq);
if (jqPath) symlinkSync(jqPath, path.join(withJq, 'jq'));

afterAll(() => rmSync(work, { recursive: true, force: true }));

let runs = 0;
function runSummary(summary: unknown, { jq = true }: { jq?: boolean } = {}) {
  const dir = path.join(work, `run-${++runs}`);
  mkdirSync(dir);
  const output = path.join(dir, 'github-output');
  const stepSummary = path.join(dir, 'step-summary');
  writeFileSync(output, '');
  writeFileSync(stepSummary, '');
  if (summary !== undefined) writeFileSync(path.join(dir, 'vibgrate-summary.json'), JSON.stringify(summary));
  const result = spawnSync(bashPath, ['--noprofile', '--norc', '-eo', 'pipefail', '-c', summaryScript], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      PATH: jq ? withJq : withoutJq,
      GITHUB_OUTPUT: output,
      GITHUB_STEP_SUMMARY: stepSummary,
      INPUT_SUMMARY: 'vibgrate-summary.json',
    },
  });
  const outputs = Object.fromEntries(
    readFileSync(output, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
  );
  return { status: result.status, stdout: result.stdout, outputs, stepSummary: readFileSync(stepSummary, 'utf8') };
}

describe('GitHub Action summary outputs', () => {
  it('found the summary step in action.yml', () => {
    expect(summaryScript).toContain('.driftScore // empty');
  });

  describe.skipIf(!jqPath)('with jq on PATH', () => {
    it('keeps a measured DriftScore of 0 and a score-delta of 0', () => {
      const { status, outputs, stepSummary } = runSummary({ driftScore: 0, riskLevel: 'low', delta: 0 });
      expect(status).toBe(0);
      expect(outputs).toEqual({
        'summary-file': 'vibgrate-summary.json',
        'drift-score': '0',
        'risk-level': 'low',
        'score-delta': '0',
      });
      expect(stepSummary).toBe('DriftScore 0/100 (low), 0 since baseline\n');
    });

    it('leaves an unmeasured score and a missing baseline empty, and writes no summary line', () => {
      const { status, outputs, stepSummary } = runSummary({ driftScore: null, riskLevel: null, delta: null });
      expect(status).toBe(0);
      expect(outputs).toEqual({
        'summary-file': 'vibgrate-summary.json',
        'drift-score': '',
        'risk-level': '',
        'score-delta': '',
      });
      expect(stepSummary).toBe('');
    });

    it.each(['low', 'moderate', 'high'])('passes riskLevel %j through as written', (riskLevel) => {
      const { outputs } = runSummary({ driftScore: 42, riskLevel, delta: null });
      expect(outputs['risk-level']).toBe(riskLevel);
    });

    it('writes a positive or negative delta as it is', () => {
      expect(runSummary({ driftScore: 47, riskLevel: 'moderate', delta: 5 }).outputs['score-delta']).toBe('5');
      expect(runSummary({ driftScore: 37, riskLevel: 'moderate', delta: -5 }).outputs['score-delta']).toBe('-5');
    });
  });

  it('notices a missing summary file and sets no outputs', () => {
    const { status, stdout, outputs } = runSummary(undefined);
    expect(status).toBe(0);
    expect(stdout).toContain(
      '::notice::the scan did not write vibgrate-summary.json, so the drift-score outputs are empty.',
    );
    expect(outputs).toEqual({});
  });

  it('notices a missing jq and still sets summary-file', () => {
    const { status, stdout, outputs } = runSummary({ driftScore: 0, riskLevel: 'low', delta: 0 }, { jq: false });
    expect(status).toBe(0);
    expect(stdout).toContain('::notice::jq is not on this runner, so the drift-score outputs are empty.');
    expect(outputs).toEqual({ 'summary-file': 'vibgrate-summary.json' });
  });
});
