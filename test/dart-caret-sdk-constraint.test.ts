/**
 * The Dart SDK constraint in pubspec.yaml sets the project runtime. Caret
 * (`^3.5.0`) and tilde forms, quoted or not, are read like `>=` ranges, and
 * `sdk: flutter` lines in dependency sections never set it.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PubCache } from '../src/core-open/scanners/pub-cache.js';
import { scanDartProjects } from '../src/core-open/scanners/dart-scanner.js';
import { Semaphore } from '../src/core-open/utils/semaphore.js';

let root: string;
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

async function runtimeFor(pubspec: string) {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'dart-sdk-'));
  fs.writeFileSync(path.join(root, 'pubspec.yaml'), pubspec);
  const projects = await scanDartProjects(root, new PubCache(new Semaphore(1), { pub: {} }, true));
  return projects[0]!.runtime;
}

describe('dart sdk constraint', () => {
  it.each([
    ['sdk: ^3.5.0', '3.5.0'],
    ['sdk: "^3.5.0"', '3.5.0'],
    ["sdk: '^3.5.0'", '3.5.0'],
    ['sdk: ~3.4.1', '3.4.1'],
    ["sdk: '>=3.0.0 <4.0.0'", '3.0.0'],
  ])('%s', async (line, expected) => {
    expect(await runtimeFor(`name: app\nenvironment:\n  ${line}\ndependencies:\n  flutter:\n    sdk: flutter\n`)).toBe(expected);
  });

  it('ignores sdk: flutter dependency lines', async () => {
    expect(await runtimeFor(`name: app\ndependencies:\n  flutter:\n    sdk: flutter\n`)).toBeUndefined();
  });
});
