/**
 * Stable degrade-and-continue warning codes.
 *
 * Two command paths must carry the exact code string: a build that skips an
 * oversized file, and a parse that throws and continues. The registry itself
 * must not publish two names for one string.
 */
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildGraph } from '../src/engine/build.js';
import runParseWorker from '../src/engine/parse-worker.js';
import { parseCvssVector } from '../src/core-open/scoring/cvss.js';
import { toCycloneDx } from '../src/reporting/commands/sbom.js';
import type { ScanArtifact } from '../src/reporting/types.js';
import {
  WarningCodes,
  publishedWarningCodes,
  stableWarningRecords,
} from '../src/warnings/codes.js';
import { cleanup, makeProject } from './helpers.js';

const PIN = '2020-01-01T00:00:00.000Z';
const dirs: string[] = [];

function project(files: Record<string, string>): string {
  const dir = makeProject(files);
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length) cleanup(dirs.pop()!);
});

describe('warning code registry', () => {
  it('publishes each code string once', () => {
    const values = Object.values(WarningCodes);
    expect(new Set(values).size).toBe(values.length);
    expect(publishedWarningCodes()).toEqual([...values].sort());
    expect(publishedWarningCodes()).toContain('VG_WARN_PARSE_DEGRADE');
    expect(publishedWarningCodes()).toContain('VG_WARN_SKIPPED_FILE');
  });

  it('orders several warnings by code, then message, and collapses exact duplicates', () => {
    const records = stableWarningRecords([
      { code: WarningCodes.SKIPPED_FILE, message: 'b.ts: skipped' },
      { code: WarningCodes.PARSE_DEGRADE, message: 'a.ts: parse failed: boom' },
      { code: WarningCodes.SKIPPED_FILE, message: 'a.ts: skipped' },
      { code: WarningCodes.SKIPPED_FILE, message: 'b.ts: skipped' },
    ]);
    expect(records.map((r) => `${r.code} ${r.message}`)).toEqual([
      'VG_WARN_PARSE_DEGRADE a.ts: parse failed: boom',
      'VG_WARN_SKIPPED_FILE a.ts: skipped',
      'VG_WARN_SKIPPED_FILE b.ts: skipped',
    ]);
  });
});

describe('build degrade warnings', () => {
  const big = `// ${'x'.repeat(400)}\nexport function huge(){ return 1; }\n`;

  it('puts VG_WARN_SKIPPED_FILE on an oversized file and keeps that order', async () => {
    const result = await buildGraph({
      root: project({
        'ok.ts': 'export const n = 1;\n',
        'b-big.ts': big,
        'a-big.ts': big,
      }),
      generatedAt: PIN,
      inline: true,
      noCache: true,
      limits: { maxFileBytes: 256 },
    });
    const skipped = result.warningRecords.filter((r) => r.code === 'VG_WARN_SKIPPED_FILE');
    expect(skipped.map((r) => r.message.split(':')[0])).toEqual(['a-big.ts', 'b-big.ts']);
    expect(result.warnings.filter((w) => w.startsWith('VG_WARN_SKIPPED_FILE:'))).toEqual(
      skipped.map((r) => `VG_WARN_SKIPPED_FILE: ${r.message}`),
    );
    expect(result.warnings.some((w) => w.includes('VG_MAX_FILE_BYTES'))).toBe(true);
  });
});

describe('parse degrade warnings', () => {
  it('puts VG_WARN_PARSE_DEGRADE on a file that cannot be read and continues', async () => {
    const missing = path.join(os.tmpdir(), 'vg-warn-missing-does-not-exist.ts');
    const parsed = await runParseWorker({
      tasks: [
        { rel: 'z.ts', abs: missing, lang: 'ts' },
        { rel: 'a.ts', abs: missing, lang: 'ts' },
      ],
    });
    expect(parsed).toHaveLength(2);
    for (const file of parsed) {
      expect(file.defs).toEqual([]);
      expect(file.warnings).toHaveLength(1);
      expect(file.warnings?.[0]).toMatch(/^VG_WARN_PARSE_DEGRADE: parse failed: /);
    }
    expect(parsed[0]?.rel).toBe('z.ts');
    expect(parsed[1]?.rel).toBe('a.ts');
  });
});

describe('report degrade warnings', () => {
  it('puts VG_WARN_PURL_UNAVAILABLE beside an omitted package URL', () => {
    const artifact = {
      schemaVersion: '1.0',
      timestamp: '2026-02-19T00:00:00.000Z',
      vibgrateVersion: '0.0.1',
      rootPath: 'repo',
      drift: {
        score: 10,
        riskLevel: 'low',
        components: { runtimeScore: 0, frameworkScore: 0, dependencyScore: 0, eolScore: 0 },
      },
      findings: [],
      projects: [
        {
          type: 'node',
          path: '.',
          name: 'app',
          frameworks: [],
          dependencies: [
            {
              package: 'foo bar',
              section: 'dependencies',
              currentSpec: '1.0.0',
              resolvedVersion: '1.0.0',
              latestStable: '1.0.0',
              majorsBehind: 0,
              drift: 'current',
            },
          ],
        },
      ],
    } as ScanArtifact;
    const cdx = toCycloneDx(artifact) as {
      components: Array<{ properties: Array<{ name: string; value: string }> }>;
    };
    const props = cdx.components[0]?.properties ?? [];
    expect(props.find((p) => p.name === 'vibgrate:purlWarningCode')?.value).toBe('VG_WARN_PURL_UNAVAILABLE');
    expect(props.find((p) => p.name === 'vibgrate:purlWarning')?.value).toContain('foo bar');
  });

  it('puts VG_WARN_CVSS_UNPARSEABLE on a vector that does not parse', () => {
    const parsed = parseCvssVector('not-a-vector');
    expect(parsed.status).toBe('invalid');
    if (parsed.status !== 'invalid') return;
    expect(parsed.diagnostic.warnCode).toBe('VG_WARN_CVSS_UNPARSEABLE');
    expect(parsed.diagnostic.code).toBe('cvss-vector-parse-failed');
    expect(parsed.diagnostic.message.startsWith('VG_WARN_CVSS_UNPARSEABLE: ')).toBe(true);
  });
});
