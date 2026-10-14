import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { evaluateConfigDriftBudget } from './drift-budget-gate.js';
import { judgeEpssGate } from './epss-gate.js';
import {
  FINDING_SKIP_NO_GATE,
  architectureGateSuite,
  configDriftBudgetCases,
  driftBudgetFlagCase,
  driftWorseningFlagCase,
  epssGateCase,
  renderScanJUnit,
  securityGateSuite,
  type JUnitFinding,
} from './junit-report.js';

const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'junit-report.fixture.xml');

const findings: JUnitFinding[] = [
  { ruleId: 'vibgrate/runtime-lag', level: 'note', message: 'Node.js 20 is one major behind', location: 'package.json' },
  { ruleId: 'vibgrate/runtime-eol', level: 'error', message: 'Node.js 16 is past end-of-life & <EOL>', location: '.nvmrc' },
  { ruleId: 'vibgrate/dependency-rot', level: 'warning', message: '62% of dependencies are 2+ majors behind', location: 'package.json' },
];

function gatedReport(order: readonly JUnitFinding[]): string {
  return renderScanJUnit({
    findings: order,
    driftGate: 'error',
    extraSuites: [{ name: 'gates', cases: [driftBudgetFlagCase(55, 40)] }],
  });
}

describe('scan JUnit XML', () => {
  it('matches the fixture for a fixed set of findings and a budget breach', () => {
    const expected = readFileSync(fixturePath, 'utf8');
    expect(gatedReport(findings)).toBe(expected);
  });

  it('emits the same bytes when the finding order changes', () => {
    const reversed = [...findings].reverse();
    const again = [findings[2]!, findings[0]!, findings[1]!];
    expect(gatedReport(reversed)).toBe(gatedReport(findings));
    expect(gatedReport(again)).toBe(gatedReport(findings));
    expect(gatedReport(findings)).toBe(gatedReport(findings));
  });

  it('omits timestamps and wall-clock time', () => {
    const xml = gatedReport(findings);
    expect(xml).not.toContain('timestamp');
    expect(xml).not.toMatch(/\btime="(?!0")/);
    expect(xml).not.toContain('1970');
  });

  it('skips every finding when no drift gate is set, and fails warnings under --fail-on warn', () => {
    const skipped = renderScanJUnit({ findings });
    expect(skipped).toContain(`message="${FINDING_SKIP_NO_GATE}"`);
    expect(skipped).not.toContain('<failure');

    const warn = renderScanJUnit({ findings, driftGate: 'warn' });
    expect(warn).toContain('type="warning"');
    expect(warn).toContain('type="error"');
    expect(warn).toContain('notes do not fail a gate');
    expect(warn).not.toContain('below the --fail-on error gate');
  });

  it('names a clean scan with a single passing testcase', () => {
    expect(renderScanJUnit({ findings: [] })).toBe(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<testsuites name="vg scan" tests="1" failures="0" errors="0" skipped="0" time="0">',
        '  <testsuite name="findings" tests="1" failures="0" errors="0" skipped="0" time="0">',
        '    <testcase classname="vg.findings" name="no findings" time="0"/>',
        '  </testsuite>',
        '</testsuites>',
        '',
      ].join('\n'),
    );
  });

  it('suffixes duplicate ruleId + location names in sort order', () => {
    const xml = renderScanJUnit({
      driftGate: 'error',
      findings: [
        { ruleId: 'vibgrate/vulnerability', level: 'error', message: 'b second', location: 'package.json' },
        { ruleId: 'vibgrate/vulnerability', level: 'error', message: 'a first', location: 'package.json' },
      ],
    });
    expect(xml).toContain('name="vibgrate/vulnerability package.json"');
    expect(xml).toContain('name="vibgrate/vulnerability package.json #2"');
    const first = xml.indexOf('message="a first"');
    const second = xml.indexOf('message="b second"');
    expect(first).toBeGreaterThan(-1);
    expect(first).toBeLessThan(second);
  });

  it('escapes quotes and apostrophes in attributes and text', () => {
    const xml = renderScanJUnit({
      driftGate: 'error',
      findings: [{ ruleId: 'vibgrate/runtime-eol', level: 'error', message: `say "eol" & don't`, location: 'a<b>' }],
    });
    expect(xml).toContain('message="say &quot;eol&quot; &amp; don&apos;t"');
    expect(xml).toContain('name="vibgrate/runtime-eol a&lt;b&gt;"');
    expect(xml).not.toContain(`say "eol"`);
  });

  it('strips characters XML 1.0 cannot encode', () => {
    const xml = renderScanJUnit({
      driftGate: 'error',
      findings: [{ ruleId: 'vibgrate/runtime-eol', level: 'error', message: 'bad\u0001byte', location: 'package.json' }],
    });
    expect(xml).toContain('badbyte');
    expect(xml).not.toContain('\u0001');
  });
});

describe('scan JUnit gates', () => {
  it('maps --drift-budget the same way the CLI gate does', () => {
    expect(driftBudgetFlagCase(null, 0)).toMatchObject({
      status: 'skipped',
      message: 'DriftScore is absent; --drift-budget 0 was not compared.',
    });
    expect(driftBudgetFlagCase(0, 0)).toMatchObject({ status: 'pass', name: 'drift-budget' });
    expect(driftBudgetFlagCase(44, 40)).toMatchObject({
      status: 'failure',
      message: 'Failing fitness function: DriftScore 44/100 exceeds budget 40.',
    });
  });

  it('maps the epss gate the same way the CLI does', () => {
    const breached = judgeEpssGate({
      threshold: 0.8,
      source: 'flag',
      scanned: true,
      vulnerabilities: {
        source: 'manifest',
        packages: [{
          ecosystem: 'npm',
          package: 'left-pad',
          version: '1.3.0',
          advisories: [{ id: 'GHSA-hot', epss: 0.9 }],
        }],
      },
    });
    expect(epssGateCase(breached)).toMatchObject({
      status: 'failure',
      classname: 'vg.gates',
      name: 'epss',
      type: 'gate',
      message: 'Failing: 1 advisory with EPSS at or above --fail-on-epss 0.8.',
    });

    const clear = judgeEpssGate({
      threshold: 0.95,
      source: 'flag',
      scanned: true,
      vulnerabilities: {
        source: 'manifest',
        packages: [{
          ecosystem: 'npm',
          package: 'left-pad',
          version: '1.3.0',
          advisories: [{ id: 'GHSA-hot', epss: 0.9 }],
        }],
      },
    });
    expect(epssGateCase(clear)).toEqual({ status: 'pass', classname: 'vg.gates', name: 'epss' });

    const absent = judgeEpssGate({ threshold: 0.8, source: 'flag', scanned: false });
    expect(epssGateCase(absent)).toMatchObject({
      status: 'skipped',
      name: 'epss',
      message: 'EPSS scores are absent; --fail-on-epss 0.8 was not compared.',
    });

    const xml = renderScanJUnit({
      findings: [],
      extraSuites: [{ name: 'gates', cases: [epssGateCase(breached)] }],
    });
    expect(xml).toContain('name="epss"');
    expect(xml).toContain('npm left-pad@1.3.0  GHSA-hot  epss 0.9');
    expect(xml.indexOf('name="findings"')).toBeLessThan(xml.indexOf('name="gates"'));
  });

  it('maps --drift-worsening, including a missing baseline', () => {
    expect(driftWorseningFlagCase(null, undefined, 5).status).toBe('skipped');
    expect(driftWorseningFlagCase(50, undefined, 5)).toMatchObject({
      status: 'failure',
      message: 'Failing fitness function: --drift-worsening requires --baseline to compare against previous drift.',
    });
    expect(driftWorseningFlagCase(50, 10, 5)).toMatchObject({
      status: 'failure',
      message: 'Failing fitness function: drift worsened by 25.00% (threshold 5%).',
    });
    expect(driftWorseningFlagCase(50, 1, 5).status).toBe('pass');
    expect(driftWorseningFlagCase(50, 0, 5).status).toBe('pass');
    expect(driftWorseningFlagCase(40, -5, 5).status).toBe('pass');
  });

  it('fails an enforced config budget and skips a warn-mode breach', () => {
    const enforced = evaluateConfigDriftBudget({
      raw: { mode: 'enforce', maxScore: 40 },
      configFile: '.vibgrate/config.yml',
      headScore: 44,
      baseScore: null,
    });
    expect(configDriftBudgetCases(enforced)).toEqual([
      {
        status: 'failure',
        classname: 'vg.gates',
        name: 'drift-budget maxScore',
        type: 'gate',
        message: 'drift budget (enforce): DriftScore 44 is above the budget of 40. Lower it by 4 points to pass.',
      },
    ]);

    const warn = evaluateConfigDriftBudget({
      raw: { maxScore: 40 },
      configFile: '.vibgrate/config.yml',
      headScore: 44,
      baseScore: null,
    });
    expect(configDriftBudgetCases(warn)[0]).toMatchObject({ status: 'skipped', name: 'drift-budget maxScore' });
    expect(warn.exitCode).toBe(0);
  });

  it('skips a worsening limit that has no baseline and drops agent-only rules', () => {
    const gate = evaluateConfigDriftBudget({
      raw: { mode: 'enforce', maxWorseningPercent: 0, agents: { maxWorseningPercent: 0 } },
      configFile: '.vibgrate/config.yml',
      headScore: 60,
      baseScore: null,
    });
    const cases = configDriftBudgetCases(gate);
    expect(cases.map((c) => c.name)).toEqual(['drift-budget maxWorseningPercent']);
    expect(cases[0]).toMatchObject({ status: 'skipped' });
    expect(cases[0]?.status === 'skipped' && cases[0].message).toContain('Run with --baseline to compare.');
  });

  it('sorts architecture rows and keeps a blocked gate as one failure', () => {
    const failed = architectureGateSuite({
      status: 'failed',
      rows: [
        { file: 'src/b.ts', line: 2, symbol: 'B', severity: 'hard', message: 'writes the store', rule: 'boundary', policy: 'hexagonal-v1' },
        { file: 'src/a.ts', symbol: 'A', severity: 'warning', message: 'reaches out', rule: 'boundary', policy: 'hexagonal-v1' },
      ],
    });
    expect(failed.cases.map((c) => c.name)).toEqual([
      'boundary src/a.ts A',
      'boundary src/b.ts:2 B',
    ]);
    expect(failed.cases[0]).toMatchObject({ status: 'failure', type: 'architecture' });

    const blocked = architectureGateSuite({ status: 'blocked', message: 'needs the map' });
    expect(blocked.cases).toEqual([
      { status: 'failure', classname: 'vg.architecture', name: 'architecture', type: 'gate', message: 'needs the map' },
    ]);
    expect(architectureGateSuite({ status: 'clean' }).cases[0]).toMatchObject({ status: 'pass', name: 'architecture' });
  });

  it('fails security findings that miss the gate and skips the rest', () => {
    const suite = securityGateSuite({
      status: 'evaluated',
      failingIds: ['bbb'],
      findings: [
        {
          id: 'bbb',
          pack: 'iac-cis-v1',
          rule: 'public-bucket',
          path: 'infra/b.tf',
          line: 4,
          severity: 'high',
          message: 'bucket is public',
        },
        {
          id: 'aaa',
          pack: 'iac-cis-v1',
          rule: 'public-bucket',
          path: 'infra/a.tf',
          severity: 'low',
          message: 'note',
        },
      ],
    });
    expect(suite.cases.map((c) => c.name)).toEqual([
      'iac-cis-v1/public-bucket infra/a.tf',
      'iac-cis-v1/public-bucket infra/b.tf',
    ]);
    expect(suite.cases[0]).toMatchObject({ status: 'skipped', message: 'below the security gate' });
    expect(suite.cases[1]).toMatchObject({ status: 'failure', type: 'high', message: 'bucket is public' });
    expect(securityGateSuite({ status: 'evaluated', findings: [], failingIds: [] }).cases[0]).toMatchObject({
      status: 'pass',
      name: 'security',
    });
  });
});
