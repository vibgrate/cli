import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runCoreScan } from '../src/core-open/index.js';

describe('offline scan network boundary', () => {
  let root: string;
  let fetchTripwire: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-offline-network-'));
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({
        name: 'offline-network-fixture',
        version: '1.0.0',
        dependencies: { 'left-pad': '^1.3.0' },
      }),
    );
    fs.writeFileSync(path.join(root, 'Dockerfile'), 'FROM node:22\n');
    fs.mkdirSync(path.join(root, 'chart'));
    fs.writeFileSync(
      path.join(root, 'chart', 'Chart.yaml'),
      [
        'apiVersion: v2',
        'name: offline-fixture',
        'version: 0.1.0',
        'dependencies:',
        '  - name: redis',
        '    version: ">=1.0.0"',
        '    repository: https://example.invalid/charts',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(root, 'main.tf'),
      [
        'terraform {',
        '  required_providers {',
        '    random = { source = "hashicorp/random", version = ">= 3.0" }',
        '  }',
        '}',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(root, 'offline-package-manifest.json'),
      JSON.stringify({
        npm: {
          'left-pad': {
            latest: '1.3.0',
            versions: ['1.3.0'],
            vulns: [
              {
                id: 'GHSA-offline-fixture',
                summary: 'Fixture advisory for the offline path',
                severity: 'moderate',
                ranges: [{ introduced: '0', fixed: '1.3.1' }],
              },
            ],
          },
        },
      }),
    );

    fetchTripwire = vi.fn(async () => {
      throw new Error('unexpected network access during offline scan');
    });
    vi.stubGlobal('fetch', fetchTripwire);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('does not call fetch and writes a manifest-backed local report', async () => {
    const reportPath = path.join(root, 'offline-report.json');

    await runCoreScan(root, {
      format: 'json',
      out: reportPath,
      concurrency: 2,
      offline: true,
      vulns: true,
      quiet: true,
      packageManifest: path.join(root, 'offline-package-manifest.json'),
      vibgrateVersion: 'test',
    });

    expect(fetchTripwire).not.toHaveBeenCalled();
    expect(fs.existsSync(reportPath)).toBe(true);
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as {
      findings: Array<{ ruleId?: string; message?: string }>;
      extended?: { vulnerabilities?: { source?: string; totalAdvisories?: number } };
    };
    expect(report.extended?.vulnerabilities).toMatchObject({ source: 'manifest', totalAdvisories: 1 });
    expect(report.findings.some((finding) => finding.message?.includes('GHSA-offline-fixture'))).toBe(true);
    expect(fs.existsSync(path.join(root, '.vibgrate', 'scan_result.json'))).toBe(true);
  });
});
