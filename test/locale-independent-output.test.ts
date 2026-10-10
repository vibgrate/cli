import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Package and project names whose ICU order is not code-unit order, and
 * differs between English and Swedish. `vg scan` JSON, SARIF, and `vg sbom`
 * must ignore that and stay byte-identical.
 */
const PACKAGE_NAMES = ['Zebra', 'apple', 'Äpfel', 'café'];
const PROJECT_NAMES = ['Zebra', 'apple', 'Äpfel'];

const CLI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EMIT = path.join(CLI_ROOT, 'test', 'locale-output-emit.ts');

function codeUnitOrder(names: readonly string[]): string[] {
  return [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function writePackage(dir: string, name: string, dependencies: Record<string, string>): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name, version: '1.0.0', dependencies }),
  );
}

interface Emitted {
  dependencyNames: string[];
  sarifMessages: string[];
  components: Array<{ name: string; projects: string }>;
}

function emit(locale: string, fixture: string): Emitted {
  const result = spawnSync(process.execPath, ['--import', 'tsx', EMIT, fixture], {
    cwd: CLI_ROOT,
    env: { ...process.env, LC_ALL: locale, LANG: locale, VIBGRATE_DSN: '' },
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`emit failed for ${locale} (status ${result.status})\n${result.stderr}\n${result.stdout}`);
  }
  const line = result.stdout.trim().split('\n').filter((row) => row.startsWith('{')).at(-1);
  if (!line) throw new Error(`no JSON from ${locale}\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(line) as Emitted;
}

describe('locale-independent machine-readable output', () => {
  it('uses package names that ICU orders differently from code units', () => {
    const en = [...PACKAGE_NAMES].sort((a, b) => a.localeCompare(b, 'en'));
    const sv = [...PACKAGE_NAMES].sort((a, b) => a.localeCompare(b, 'sv'));
    const code = codeUnitOrder(PACKAGE_NAMES);
    expect(en).not.toEqual(sv);
    expect(code).not.toEqual(en);
    expect(code).not.toEqual(sv);
    expect(codeUnitOrder(PROJECT_NAMES)).not.toEqual([...PROJECT_NAMES].sort((a, b) => a.localeCompare(b, 'en')));
  });

  it('emits the same scan JSON, SARIF, and SBOM order under en_US and sv_SE', () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-locale-'));
    try {
      writePackage(fixture, 'root-app', {
        Zebra: '1.0.0',
        apple: '1.0.0',
        Äpfel: '1.0.0',
        café: '1.0.0',
        shared: '1.0.0',
      });
      for (const name of PROJECT_NAMES) {
        writePackage(path.join(fixture, 'apps', name), name, { shared: '1.0.0' });
      }

      const en = emit('en_US.UTF-8', fixture);
      const sv = emit('sv_SE.UTF-8', fixture);

      expect(sv).toEqual(en);
      expect(en.dependencyNames).toEqual(codeUnitOrder(['Zebra', 'apple', 'Äpfel', 'café', 'shared']));

      const licenseNames = codeUnitOrder([...PACKAGE_NAMES, 'shared']);
      const licenseMessages = en.sarifMessages.filter((message) => message.includes('NOT-A-LICENSE'));
      expect(licenseMessages.map((message) => licenseNames.find((name) => message.includes(`for ${name} `)))).toEqual(
        licenseNames,
      );

      const shared = en.components.find((component) => component.name === 'shared');
      expect(shared?.projects).toBe(codeUnitOrder([...PROJECT_NAMES, 'root-app']).join(', '));
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  }, 60_000);
});
