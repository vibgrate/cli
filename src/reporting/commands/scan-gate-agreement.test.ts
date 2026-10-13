// One table-driven `vg scan` run per gate outcome. Exit code, the human
// stderr line, and `--junit` `<failure>` / `<skipped>` counts have to agree.
//
// `--drift-worsening` with a measured score and no `--baseline` exits 2 and
// the JUnit case is a `<failure>`. The flag cannot compare, so it fails
// closed. That split is intentional: the same gap on
// `driftBudget.maxWorseningPercent` is not evaluated, the case is
// `<skipped>`, and the scan exits 0. See DOCS.md (JUnit, Exit Codes).
import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { scanCommand } from './scan.js';

/** Pinned runtime catalog so EOL and major lag do not follow the wall clock. */
const RUNTIME_MANIFEST = {
  runtimes: {
    generatedAt: '2026-01-01T00:00:00.000Z',
    source: 'endoflife.date',
    products: {
      nodejs: {
        product: 'nodejs',
        cycles: [
          { cycle: '20', releaseDate: '2020-01-01', lts: true, eol: false },
          { cycle: '18', releaseDate: '2019-01-01', lts: true, eol: false },
          { cycle: '16', releaseDate: '2018-01-01', lts: true, eol: true },
        ],
      },
    },
  },
};

interface GateRow {
  name: string;
  /** `engines.node`. Omit it and DriftScore stays unmeasured. */
  node?: string;
  /** `.vibgrate/config.yml` body, when the row uses a project budget. */
  config?: string;
  args: string[];
  exit: 0 | 2;
  /** Stable substring of the human report (stdout) or the gate line (stderr). */
  summary: string;
  /** Named `vg.gates` case, when this row judges one. */
  gate?: { name: string; status: 'failure' | 'skipped' };
  /** Minimum `<failure>` count in the findings suite. */
  findingsFailures?: number;
}

const ROWS: GateRow[] = [
  {
    name: 'no gates',
    args: [],
    exit: 0,
    summary: 'DriftScore Summary',
  },
  {
    name: '--fail-on error with an error finding',
    node: '16.20.0',
    args: ['--fail-on', 'error'],
    exit: 2,
    summary: 'error finding(s) detected',
    findingsFailures: 1,
  },
  {
    name: '--fail-on warn with only a warning',
    node: '18.20.0',
    args: ['--fail-on', 'warn'],
    exit: 2,
    summary: 'findings detected at warn level or above',
    findingsFailures: 1,
  },
  {
    name: '--drift-budget breached',
    node: '18.20.0',
    args: ['--drift-budget', '0'],
    exit: 2,
    summary: 'exceeds budget 0',
    gate: { name: 'drift-budget', status: 'failure' },
  },
  {
    name: 'driftBudget warn mode breached',
    node: '18.20.0',
    config: 'driftBudget:\n  mode: warn\n  maxScore: 0\n',
    args: [],
    exit: 0,
    summary: 'drift budget (warn):',
    gate: { name: 'drift-budget maxScore', status: 'skipped' },
  },
  {
    name: 'driftBudget shadow mode breached',
    node: '18.20.0',
    config: 'driftBudget:\n  mode: shadow\n  maxScore: 0\n',
    args: [],
    exit: 0,
    summary: 'drift budget (shadow):',
    gate: { name: 'drift-budget maxScore', status: 'skipped' },
  },
  {
    name: '--drift-worsening without --baseline',
    node: '18.20.0',
    args: ['--drift-worsening', '5'],
    exit: 2,
    summary: '--drift-worsening requires --baseline',
    gate: { name: 'drift-worsening', status: 'failure' },
  },
  {
    name: 'driftBudget maxWorseningPercent without --baseline',
    node: '18.20.0',
    config: 'driftBudget:\n  mode: enforce\n  maxWorseningPercent: 0\n',
    args: [],
    exit: 0,
    summary: 'Run with --baseline to compare.',
    gate: { name: 'drift-budget maxWorseningPercent', status: 'skipped' },
  },
  {
    name: 'unmeasured score with a budget set',
    args: ['--drift-budget', '0'],
    exit: 0,
    summary: 'DriftScore is absent; --drift-budget 0 was not compared.',
    gate: { name: 'drift-budget', status: 'skipped' },
  },
];

function plain(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, '');
}

function suiteTotals(xml: string): { failures: number; skipped: number } {
  const match = xml.match(/<testsuites name="vg scan" tests="\d+" failures="(\d+)" errors="0" skipped="(\d+)"/);
  if (!match) throw new Error(`JUnit report is missing a testsuites root:\n${xml}`);
  return { failures: Number(match[1]), skipped: Number(match[2]) };
}

function findingsFailures(xml: string): number {
  const match = xml.match(/<testsuite name="findings" tests="\d+" failures="(\d+)"/);
  if (!match) throw new Error(`JUnit report is missing a findings suite:\n${xml}`);
  return Number(match[1]);
}

function gateCase(xml: string, name: string): 'pass' | 'failure' | 'skipped' {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = xml.match(new RegExp(`<testcase classname="vg\\.gates" name="${escaped}" time="0"(/>|>([\\s\\S]*?)</testcase>)`));
  if (!match) throw new Error(`JUnit report has no vg.gates case named ${JSON.stringify(name)}`);
  if (match[1] === '/>') return 'pass';
  const body = match[2] ?? '';
  if (body.includes('<failure')) return 'failure';
  if (body.includes('<skipped')) return 'skipped';
  throw new Error(`JUnit case ${JSON.stringify(name)} has no status:\n${body}`);
}

describe('vg scan exit code, summary, and JUnit agree', () => {
  const dirs: string[] = [];
  let stderr = '';
  let stdout = '';
  let logSpy: ReturnType<typeof vi.spyOn> | undefined;
  let errorSpy: ReturnType<typeof vi.spyOn> | undefined;
  let exitSpy: ReturnType<typeof vi.spyOn> | undefined;

  afterEach(() => {
    logSpy?.mockRestore();
    errorSpy?.mockRestore();
    exitSpy?.mockRestore();
    vi.unstubAllEnvs();
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function project(row: GateRow): { dir: string; junit: string } {
    const dir = fs.mkdtempSync(path.join(tmpdir(), 'vg-gate-'));
    dirs.push(dir);
    const pkg: { name: string; version: string; engines?: { node: string } } = {
      name: 'gate-fixture',
      version: '1.0.0',
    };
    if (row.node) pkg.engines = { node: row.node };
    fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(pkg)}\n`);
    fs.writeFileSync(path.join(dir, 'versions.json'), `${JSON.stringify(RUNTIME_MANIFEST)}\n`);
    if (row.config) {
      fs.mkdirSync(path.join(dir, '.vibgrate'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.vibgrate', 'config.yml'), row.config);
    }
    return { dir, junit: path.join(dir, 'report.junit.xml') };
  }

  async function run(dir: string, junit: string, args: string[]): Promise<0 | 2> {
    stderr = '';
    stdout = '';
    logSpy?.mockRestore();
    errorSpy?.mockRestore();
    exitSpy?.mockRestore();
    vi.stubEnv('VIBGRATE_DSN', '');
    vi.stubEnv('VIBGRATE_NO_KERNEL', '1');
    logSpy = vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => {
      stdout += parts.map(String).join(' ') + '\n';
    });
    errorSpy = vi.spyOn(console, 'error').mockImplementation((...parts: unknown[]) => {
      stderr += parts.map(String).join(' ') + '\n';
    });
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code}) called`);
    }) as never);

    const argv = [
      'node', 'scan', dir,
      '--offline', '--no-daemon', '--no-graph', '--no-local-artifacts',
      '--package-manifest', path.join(dir, 'versions.json'),
      '--junit', junit,
      ...args,
    ];
    try {
      await scanCommand.parseAsync(argv);
      expect(exitSpy).not.toHaveBeenCalled();
      return 0;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === 'process.exit(2) called') return 2;
      throw err;
    }
  }

  it('locks exit code, the summary line, and JUnit failure vs skipped counts', async () => {
    for (const row of ROWS) {
      const { dir, junit } = project(row);
      const exit = await run(dir, junit, row.args);
      const report = plain(`${stdout}\n${stderr}`);
      const xml = fs.readFileSync(junit, 'utf8');
      const totals = suiteTotals(xml);

      const detail = [
        row.name,
        `exit ${exit}`,
        `junit failures=${totals.failures} skipped=${totals.skipped}`,
        report,
        xml,
      ].join('\n');

      expect(exit, detail).toBe(row.exit);
      expect(report, detail).toContain(row.summary);
      expect(totals.failures > 0, detail).toBe(exit !== 0);
      if (row.gate?.status === 'skipped') expect(totals.skipped, detail).toBeGreaterThanOrEqual(1);
      if (row.gate?.status === 'failure') expect(xml, detail).toContain(row.summary);
      expect(xml, detail).not.toContain('timestamp');
      expect(xml, detail).not.toContain(dir);

      if (row.findingsFailures !== undefined) {
        expect(findingsFailures(xml), detail).toBeGreaterThanOrEqual(row.findingsFailures);
      }
      if (row.name.startsWith('--fail-on warn')) {
        expect(xml, detail).toContain('type="warning"');
        expect(xml, detail).not.toContain('type="error"');
      }
      if (row.gate) {
        expect(gateCase(xml, row.gate.name), detail).toBe(row.gate.status);
      } else {
        expect(xml, detail).not.toContain('classname="vg.gates"');
      }
      if (exit === 0) {
        expect(report, detail).not.toContain('Failing');
        expect(xml, detail).not.toContain('<failure');
      }
    }
  }, 180_000);
});
