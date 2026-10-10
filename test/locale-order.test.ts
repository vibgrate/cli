import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compareCodeUnit } from '../src/util/compare.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(REPO, 'src/cli.ts');
const LOCALES = ['C', 'en_US.UTF-8', 'et_EE.UTF-8'] as const;
const PROBE = ['zod', 'semver', 'tslib', 'yargs', 'ini'];
/** Code-unit order. Estonian collation puts `zod` before `tslib`. */
const CODE_UNIT_PACKAGES = ['ini', 'semver', 'shared', 'tslib', 'yargs', 'zod'];

const OUTPUT_SHAPING = [
  'src/reporting/commands/sbom.ts',
  'src/reporting/commands/scan.ts',
  'src/reporting/reachability.ts',
  'src/reporting/junit-report.ts',
  'src/reporting/formatters/html.ts',
  'src/engine/lockfile.ts',
  'src/engine/warning-codes.ts',
  'src/core-open/warnings.ts',
  'src/core-open/run-core-scan.ts',
  'src/core-open/scoring/drift-score.ts',
  'src/core-open/scoring/dependency-drift-v3.ts',
  'src/core-open/formatters/sarif.ts',
  'src/core-open/scanners/node-scanner.ts',
  'src/core-open/scanners/ruby-scanner.ts',
  'src/core-open/scanners/dart-scanner.ts',
  'src/core-open/scanners/java-scanner.ts',
  'src/core-open/scanners/python-scanner.ts',
  'src/core-open/scanners/rust-scanner.ts',
  'src/core-open/scanners/php-scanner.ts',
  'src/core-open/scanners/go-scanner.ts',
  'src/core-open/scanners/dotnet-scanner.ts',
  'src/core-open/scanners/swift-scanner.ts',
  'src/core-open/scanners/vulnerability-scanner.ts',
];

function bareLocaleCompare(source: string): string[] {
  const hits: string[] = [];
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (!line.includes('.localeCompare(')) continue;
    if (/\.localeCompare\s*\([^)\n]*,/.test(line)) continue;
    hits.push(`${i + 1}: ${line.trim()}`);
  }
  return hits;
}

function localeProbe(locale: string): string {
  const res = spawnSync(
    process.execPath,
    ['-e', `process.stdout.write(${JSON.stringify(PROBE)}.sort((a,b)=>a.localeCompare(b)).join(' '))`],
    { encoding: 'utf8', env: { ...process.env, LC_ALL: locale, LANG: locale } },
  );
  expect(res.status, res.stderr).toBe(0);
  return res.stdout;
}

function runVg(locale: string, args: string[]): { stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, ['--import', 'tsx', CLI, ...args], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 90_000,
    env: {
      ...process.env,
      LC_ALL: locale,
      LANG: locale,
      NO_COLOR: '1',
      FORCE_COLOR: '0',
      VIBGRATE_NO_KERNEL: '1',
      VIBGRATE_DSN: '',
    },
  });
  expect(res.status, `${locale} vg ${args.join(' ')}\n${res.stderr}\n${res.stdout}`).toBe(0);
  return { stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

/** Drop wall-clock fields so locale runs can be compared byte for byte. */
function normalizeMachineOutput(text: string): string {
  return text
    .replace(/"timestamp"\s*:\s*"[^"]*"/g, '"timestamp": "1970-01-01T00:00:00.000Z"')
    .replace(/"startTimeUtc"\s*:\s*"[^"]*"/g, '"startTimeUtc": "1970-01-01T00:00:00.000Z"')
    .replace(/"scannedAt"\s*:\s*"[^"]*"/g, '"scannedAt": "1970-01-01T00:00:00.000Z"')
    .replace(/"durationMs"\s*:\s*\d+/g, '"durationMs": 0');
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function packageJson(name: string): unknown {
  return {
    name,
    version: '1.0.0',
    dependencies: {
      zod: '1.0.0',
      semver: '1.0.0',
      tslib: '1.0.0',
      yargs: '1.0.0',
      ini: '1.0.0',
      shared: '1.0.0',
    },
  };
}

/** Two lockfiles resolve `shared@1.0.0` to different dependency lists. */
function packageLock(name: string, sharedDep: string): unknown {
  return {
    name,
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': { name, version: '1.0.0', dependencies: { shared: '1.0.0' } },
      'node_modules/shared': { version: '1.0.0', dependencies: { [sharedDep]: '1.0.0' } },
      [`node_modules/${sharedDep}`]: { version: '1.0.0' },
    },
  };
}

function makeFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-locale-'));
  writeJson(path.join(root, 'apps', 'tslib', 'package.json'), packageJson('app-tslib'));
  writeJson(path.join(root, 'apps', 'tslib', 'package-lock.json'), packageLock('app-tslib', 'left-pad'));
  writeJson(path.join(root, 'apps', 'zod', 'package.json'), packageJson('app-zod'));
  writeJson(path.join(root, 'apps', 'zod', 'package-lock.json'), packageLock('app-zod', 'right-pad'));
  return root;
}

interface SbomComponent {
  name: string;
  'bom-ref': string;
  properties?: Array<{ name: string; value: string }>;
}

interface SbomDoc {
  components: SbomComponent[];
  dependencies?: Array<{ ref: string; dependsOn: string[] }>;
}

function property(component: SbomComponent, name: string): string | undefined {
  return component.properties?.find((entry) => entry.name === name)?.value;
}

describe('locale-independent machine-readable order', () => {
  it('code-unit order keeps tslib before zod when Estonian collation does not', () => {
    expect(localeProbe('et_EE.UTF-8')).toBe('ini semver zod tslib yargs');
    expect(localeProbe('en_US.UTF-8')).toBe('ini semver tslib yargs zod');
    expect(localeProbe('C')).toBe('ini semver tslib yargs zod');
    expect([...PROBE].sort(compareCodeUnit)).toEqual(['ini', 'semver', 'tslib', 'yargs', 'zod']);
  });

  it('flags bare localeCompare in output-shaping modules', () => {
    const hits: string[] = [];
    for (const rel of OUTPUT_SHAPING) {
      const source = fs.readFileSync(path.join(REPO, rel), 'utf8');
      for (const hit of bareLocaleCompare(source)) hits.push(`${rel}:${hit}`);
    }
    expect(hits).toEqual([]);
  });

  it('sorts coded and plain warnings the same way under C, en_US, and et_EE', () => {
    const script = path.join(os.tmpdir(), `vg-warn-sort-${process.pid}.mts`);
    const warningsUrl = pathToFileURL(path.join(REPO, 'src/core-open/warnings.ts')).href;
    const assembleUrl = pathToFileURL(path.join(REPO, 'src/engine/warning-codes.ts')).href;
    fs.writeFileSync(
      script,
      [
        `import { sortCodedWarnings } from ${JSON.stringify(warningsUrl)};`,
        `import { assembleEngineWarnings } from ${JSON.stringify(assembleUrl)};`,
        'const coded = sortCodedWarnings([',
        "  { code: 'VG_WARN_PARSE_FAILED', message: 'zod exploded' },",
        "  { code: 'VG_WARN_PARSE_FAILED', message: 'tslib exploded' },",
        "  { code: 'VG_WARN_PARSE_FAILED', message: 'yargs exploded' },",
        "  { code: 'VG_WARN_PARSE_FAILED', message: 'ini exploded' },",
        ']);',
        "const assembled = assembleEngineWarnings(['zod plain', 'tslib plain', 'yargs plain', 'ini plain']);",
        'process.stdout.write(JSON.stringify({',
        '  coded: coded.map((warning) => warning.message),',
        '  plain: assembled.warnings,',
        '}));',
        '',
      ].join('\n'),
    );
    const expectedCoded = ['ini exploded', 'tslib exploded', 'yargs exploded', 'zod exploded'];
    const expectedPlain = ['ini plain', 'tslib plain', 'yargs plain', 'zod plain'];
    const bodies: string[] = [];
    try {
      for (const locale of LOCALES) {
        const res = spawnSync(process.execPath, ['--import', 'tsx', script], {
          cwd: REPO,
          encoding: 'utf8',
          timeout: 60_000,
          env: { ...process.env, LC_ALL: locale, LANG: locale, NO_COLOR: '1' },
        });
        expect(res.status, res.stderr).toBe(0);
        const parsed = JSON.parse(res.stdout) as { coded: string[]; plain: string[] };
        expect(parsed.coded).toEqual(expectedCoded);
        expect(parsed.plain).toEqual(expectedPlain);
        bodies.push(res.stdout);
      }
    } finally {
      fs.rmSync(script, { force: true });
    }
    expect(new Set(bodies).size).toBe(1);
  });

  it('keeps vg scan JSON/SARIF and vg sbom export byte-identical across locales', () => {
    const root = makeFixture();
    try {
      const scanJson: string[] = [];
      const scanSarif: string[] = [];
      for (const locale of LOCALES) {
        const json = runVg(locale, [
          'scan', root, '--format', 'json', '--offline', '--quiet', '--no-graph', '--no-daemon', '--no-local-artifacts',
        ]);
        const sarif = runVg(locale, [
          'scan', root, '--format', 'sarif', '--offline', '--quiet', '--no-graph', '--no-daemon', '--no-local-artifacts',
        ]);
        scanJson.push(normalizeMachineOutput(json.stdout));
        scanSarif.push(normalizeMachineOutput(sarif.stdout));
      }
      expect(scanJson[1]).toBe(scanJson[0]);
      expect(scanJson[2]).toBe(scanJson[0]);
      expect(scanSarif[1]).toBe(scanSarif[0]);
      expect(scanSarif[2]).toBe(scanSarif[0]);

      const artifact = JSON.parse(scanJson[0]!) as {
        timestamp?: string;
        projects: Array<{ name: string; path: string; dependencies: Array<{ package: string }> }>;
      };
      expect(artifact.projects.map((project) => project.path).sort(compareCodeUnit)).toEqual(['apps/tslib', 'apps/zod']);
      for (const project of artifact.projects) {
        expect(project.dependencies.map((dep) => dep.package)).toEqual(CODE_UNIT_PACKAGES);
      }

      artifact.timestamp = '2020-01-01T00:00:00.000Z';
      const artifactPath = path.join(root, '.vibgrate', 'scan_result.json');
      writeJson(artifactPath, artifact);
      const sboms: string[] = [];
      for (const locale of LOCALES) {
        const exported = runVg(locale, ['sbom', 'export', '--in', artifactPath, '--root', root, '--format', 'cyclonedx']);
        sboms.push(exported.stdout);
      }
      expect(sboms[1]).toBe(sboms[0]);
      expect(sboms[2]).toBe(sboms[0]);

      const sbom = JSON.parse(sboms[0]!) as SbomDoc;
      expect(sbom.components.map((component) => component.name)).toEqual(
        [...sbom.components.map((component) => component.name)].sort(compareCodeUnit),
      );
      const shared = sbom.components.find((component) => component.name === 'shared');
      expect(shared).toBeDefined();
      expect(property(shared!, 'vibgrate:projects')).toBe('app-tslib, app-zod');
      expect(property(shared!, 'vibgrate:mergeWarning')).toContain('kept the list from project "app-tslib"');
      expect(property(shared!, 'vibgrate:mergeWarning')).toContain('project "app-zod"');
      const edges = sbom.dependencies?.find((row) => row.ref === shared!['bom-ref']);
      expect(edges?.dependsOn).toEqual(['pkg:npm/left-pad@1.0.0']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 180_000);
});
