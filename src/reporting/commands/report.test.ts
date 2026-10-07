import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { reportCommand } from './report.js';
import { ExitCode } from '../../util/exit.js';

const artifact = {
  schemaVersion: '1.0',
  timestamp: '2026-01-01T00:00:00.000Z',
  vibgrateVersion: '0.0.0',
  rootPath: '/fixture',
  projects: [
    {
      type: 'node',
      path: 'app',
      name: 'report-format-sentinel',
      frameworks: [],
      dependencies: [],
      dependencyAgeBuckets: { current: 0, oneBehind: 0, twoPlusBehind: 0, unknown: 0 },
    },
  ],
  drift: {
    score: 1,
    riskLevel: 'low',
    components: { runtimeScore: 0, frameworkScore: 0, dependencyScore: 0, eolScore: 0 },
  },
  findings: [],
};

const roots: string[] = [];

function writeArtifact(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-report-format-'));
  roots.push(root);
  const file = path.join(root, 'scan_result.json');
  fs.writeFileSync(file, JSON.stringify(artifact));
  return file;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('vg report --format', () => {
  it('lists html in the help text', () => {
    expect(reportCommand.helpInformation()).toContain('md|text|json|html');
  });

  it('rejects an unknown format before reading the artifact', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`EXIT:${code ?? 0}`);
    }) as never);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    for (const format of ['sarif', 'HTML', 'html ']) {
      await expect(
        reportCommand.parseAsync(['--format', format, '--in', '/no/such/scan_result.json'], { from: 'user' }),
      ).rejects.toThrow(`unknown --format ${JSON.stringify(format)} (expected md, text, json, html)`);
    }

    expect(logSpy).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('prints html, and leaves md and json on their existing paths', async () => {
    const file = writeArtifact();
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => {
      logs.push(parts.map((part) => String(part)).join(' '));
    });

    logs.length = 0;
    await reportCommand.parseAsync(['--in', file, '--format', 'html'], { from: 'user' });
    expect(logs.join('\n')).toContain('<section id="summary"');
    expect(logs.join('\n')).toContain('DriftScore: 1/100');
    expect(logs.join('\n')).not.toContain('# Vibgrate Drift Report');

    logs.length = 0;
    await reportCommand.parseAsync(['--in', file, '--format', 'md'], { from: 'user' });
    const md = logs.join('\n');
    expect(md).toContain('# Vibgrate Drift Report');
    expect(md).toContain('report-format-sentinel');
    expect(md).not.toContain('<!doctype html>');

    logs.length = 0;
    await reportCommand.parseAsync(['--in', file, '--format', 'json'], { from: 'user' });
    expect(JSON.parse(logs.join('\n'))).toEqual(artifact);

    logs.length = 0;
    await reportCommand.parseAsync(['--in', file, '--format', 'text'], { from: 'user' });
    expect(logs.join('\n')).toContain('Vibgrate Drift Report');
    expect(logs.join('\n')).toContain('report-format-sentinel');
    expect(logs.join('\n')).not.toContain('<!doctype html>');
  });

  it('uses the usage-error exit code for a bad format', async () => {
    await expect(
      reportCommand.parseAsync(['--format', 'sarif'], { from: 'user' }),
    ).rejects.toMatchObject({ code: ExitCode.USAGE_ERROR });
  });
});
