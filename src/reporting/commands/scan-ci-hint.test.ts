// Owned by the public CLI. The post-scan "biggest drift driver" panel and the
// `init --ci github` suggestion are for a person at a terminal. Machine-readable
// and CI output must be byte-identical whether or not that panel would have
// been shown. Lives here (not under src/core-open, which the vendor sync wipes)
// and drives the real `vg scan` command.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { scanCommand } from './scan.js';

const HINT_TITLE = 'KEEP YOUR DRIFTSCORE FROM GETTING WORSE';
const INIT_CMD = 'init --ci github';

/** Same pillar order the text panel uses. The first measured score above 0 wins a tie. */
const PILLARS = [
  { key: 'runtimeScore', label: 'Runtime' },
  { key: 'frameworkScore', label: 'Frameworks' },
  { key: 'dependencyScore', label: 'Dependencies' },
  { key: 'eolScore', label: 'EOL risk' },
] as const;

const CI_KEYS = ['CI', 'GITHUB_ACTIONS', 'GITLAB_CI', 'CIRCLECI', 'TRAVIS', 'BUILDKITE', 'JENKINS_URL', 'TF_BUILD'] as const;

/** Frozen so two scans of one fixture share a timestamp and a duration. */
const FIXED_NOW = Date.parse('2026-06-01T12:00:00.000Z');

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

function assertNoHint(text: string): void {
  expect(text).not.toContain(HINT_TITLE);
  expect(text).not.toContain(INIT_CMD);
  expect(text).not.toContain('Biggest driver:');
}

interface DriftComponents {
  runtimeScore: number | null;
  frameworkScore: number | null;
  dependencyScore: number | null;
  eolScore: number | null;
}

function biggestDriver(components: DriftComponents): { label: string; score: number } {
  let best: { label: string; score: number } | null = null;
  for (const pillar of PILLARS) {
    const score = components[pillar.key];
    if (typeof score === 'number' && score > 0 && (best === null || score > best.score)) {
      best = { label: pillar.label, score };
    }
  }
  if (!best) throw new Error('fixture produced no measured drift driver');
  return best;
}

describe('vg scan post-scan CI hint stays out of non-interactive output', () => {
  let root: string;
  let outs: string;
  let stdout: string;
  let stderr: string;
  let restoreTty: (() => void) | undefined;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(tmpdir(), 'vg-ci-hint-'));
    outs = fs.mkdtempSync(path.join(tmpdir(), 'vg-ci-hint-out-'));
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({
        name: 'hint-fixture',
        version: '1.0.0',
        engines: { node: '14.21.3' },
      }),
    );
    vi.useFakeTimers({ toFake: ['Date'], now: FIXED_NOW });
    vi.stubEnv('VIBGRATE_DSN', '');
    vi.stubEnv('VIBGRATE_EMIT_MARKERS', '');
    stdout = '';
    stderr = '';
    // The text report, JSON, and SARIF go out through console.log. Progress
    // writes stderr directly. Capture both so a hint on either stream is visible.
    logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      stdout += args.map((part) => String(part)).join(' ') + '\n';
    });
    errorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      stderr += args.map((part) => String(part)).join(' ') + '\n';
    });
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      stdout += String(chunk);
      return true;
    });
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      stderr += String(chunk);
      return true;
    });
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
  });

  afterEach(() => {
    restoreTty?.();
    restoreTty = undefined;
    logSpy.mockRestore();
    errorSpy.mockRestore();
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outs, { recursive: true, force: true });
  });

  function setCi(on: boolean): void {
    if (on) {
      vi.stubEnv('CI', 'true');
      return;
    }
    for (const key of CI_KEYS) vi.stubEnv(key, '');
  }

  function setStdoutTty(tty: boolean): void {
    restoreTty?.();
    const descriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, enumerable: true, value: tty });
    restoreTty = () => {
      if (descriptor) Object.defineProperty(process.stdout, 'isTTY', descriptor);
      else Reflect.deleteProperty(process.stdout, 'isTTY');
    };
  }

  function resetCapture(): void {
    stdout = '';
    stderr = '';
  }

  async function scan(args: string[]): Promise<void> {
    resetCapture();
    await scanCommand.parseAsync(['node', 'scan', root, '--offline', '--no-daemon', '--no-graph', '--no-local-artifacts', ...args]);
  }

  it('piped stdout and CI=true are byte-identical and omit the hint', async () => {
    setCi(false);
    setStdoutTty(false);
    await scan([]);
    const pipedOut = stdout;
    const pipedErr = stderr;

    setCi(true);
    setStdoutTty(true);
    await scan([]);

    expect(stdout).toBe(pipedOut);
    expect(stderr).toBe(pipedErr);
    assertNoHint(stdout);
    assertNoHint(stderr);
    expect(stdout).toContain('DriftScore');
  });

  it('--format json is byte-identical on a TTY and a pipe, with no hint', async () => {
    setCi(false);
    setStdoutTty(true);
    await scan(['--format', 'json']);
    const ttyOut = stdout;
    const ttyErr = stderr;

    setStdoutTty(false);
    await scan(['--format', 'json']);

    expect(stdout).toBe(ttyOut);
    expect(stderr).toBe(ttyErr);
    assertNoHint(stdout);
    assertNoHint(stderr);
    const artifact = JSON.parse(stdout) as { drift: { score: number | null; components: DriftComponents } };
    expect(artifact.drift.score).not.toBeNull();
    expect(biggestDriver(artifact.drift.components).score).toBeGreaterThan(0);
    expect(JSON.stringify(artifact)).not.toContain('ciHint');
  });

  it('--format sarif is byte-identical on a TTY and a pipe, with no hint', async () => {
    setCi(false);
    setStdoutTty(true);
    await scan(['--format', 'sarif']);
    const ttyOut = stdout;
    const ttyErr = stderr;

    setStdoutTty(false);
    await scan(['--format', 'sarif']);

    expect(stdout).toBe(ttyOut);
    expect(stderr).toBe(ttyErr);
    assertNoHint(stdout);
    assertNoHint(stderr);
    const sarif = JSON.parse(stdout) as { version: string };
    expect(sarif.version).toBe('2.1.0');
    expect(JSON.stringify(sarif)).not.toContain('ciHint');
  });

  it('--junit file and non-interactive stdout omit the hint and match a run without it', async () => {
    const pipedFile = path.join(outs, 'piped.xml');
    const ttyFile = path.join(outs, 'tty.xml');

    setCi(false);
    setStdoutTty(false);
    await scan([]);
    const textOut = stdout;
    const textErr = stderr;
    assertNoHint(textOut);

    await scan(['--junit', pipedFile]);
    expect(stdout).toBe(textOut);
    expect(stderr.startsWith(textErr)).toBe(true);
    assertNoHint(stdout);
    assertNoHint(stderr);
    const pipedXml = fs.readFileSync(pipedFile, 'utf8');
    assertNoHint(pipedXml);

    setStdoutTty(true);
    await scan(['--junit', ttyFile]);
    expect(stripAnsi(stdout)).toContain(HINT_TITLE);
    expect(stripAnsi(stdout)).toContain(INIT_CMD);
    assertNoHint(stderr);
    const ttyXml = fs.readFileSync(ttyFile, 'utf8');
    expect(ttyXml).toBe(pipedXml);
    assertNoHint(ttyXml);
  });

  it('an interactive TTY names the driver JSON ranks first, on stdout', async () => {
    setCi(false);
    setStdoutTty(false);
    await scan(['--format', 'json']);
    assertNoHint(stdout);
    const artifact = JSON.parse(stdout) as { drift: { components: DriftComponents } };
    const driver = biggestDriver(artifact.drift.components);

    setStdoutTty(true);
    await scan([]);
    const report = stripAnsi(stdout);
    expect(report).toContain(HINT_TITLE);
    expect(report).toContain(`Biggest driver: ${driver.label} (${driver.score}/100)`);
    expect(report).toContain(INIT_CMD);
    expect(report).not.toContain(`${INIT_CMD} .`);
    assertNoHint(stderr);
  });

  it('--quiet hides the hint on an interactive TTY', async () => {
    setCi(false);
    setStdoutTty(true);
    await scan(['--quiet']);
    assertNoHint(stdout);
    assertNoHint(stderr);
    expect(stdout).toContain('DriftScore');
  });
});
