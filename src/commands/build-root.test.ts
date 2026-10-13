import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { discover } from '../engine/discover.js';
import { resolveBuildRoot } from './build.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tree(): { parent: string; decoy: string; target: string } {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-build-root-'));
  dirs.push(parent);
  const decoy = path.join(parent, 'cwd-decoy');
  const target = path.join(parent, 'target');
  fs.mkdirSync(path.join(decoy, 'src'), { recursive: true });
  fs.mkdirSync(path.join(target, 'src'), { recursive: true });
  fs.writeFileSync(path.join(decoy, 'src', 'decoy.ts'), 'export const decoy = 1;\n');
  fs.writeFileSync(path.join(target, 'src', 'app.ts'), 'export const app = 1;\n');
  fs.writeFileSync(path.join(target, 'package-lock.json'), '{}\n');
  return { parent, decoy, target };
}

describe('resolveBuildRoot', () => {
  it('maps a directory outside the working directory as its own project', () => {
    const { decoy, target } = tree();
    expect(resolveBuildRoot(decoy, ['../target'])).toEqual({ root: target, paths: [] });
    expect(resolveBuildRoot(decoy, [target])).toEqual({ root: target, paths: [] });
  });

  it('keeps a path inside the working directory as a scope', () => {
    const { parent, target } = tree();
    expect(resolveBuildRoot(parent, ['target'])).toEqual({ root: parent, paths: ['target'] });
    expect(resolveBuildRoot(target, [])).toEqual({ root: target, paths: [] });
    expect(resolveBuildRoot(target, ['.'])).toEqual({ root: target, paths: ['.'] });
    expect(resolveBuildRoot(target, ['src'])).toEqual({ root: target, paths: ['src'] });
  });

  it('keeps a file, and more than one path, as a scope of the working directory', () => {
    const { decoy, target } = tree();
    const file = path.join(target, 'src', 'app.ts');
    expect(resolveBuildRoot(decoy, ['../target/src/app.ts'])).toEqual({
      root: decoy,
      paths: ['../target/src/app.ts'],
    });
    expect(resolveBuildRoot(decoy, ['../target', file])).toEqual({
      root: decoy,
      paths: ['../target', file],
    });
  });
});

describe('discover outside the project root', () => {
  it('skips a scope directory outside the root instead of rejecting its relative path', () => {
    const { decoy, target } = tree();
    expect(discover({ root: decoy, paths: [target] }).map((file) => file.rel)).toEqual([]);
  });

  it('still maps a file whose name begins with two dots', () => {
    const { decoy } = tree();
    fs.writeFileSync(path.join(decoy, 'src', '..keep.ts'), 'export const keep = 1;\n');
    expect(discover({ root: decoy }).map((file) => file.rel)).toContain('src/..keep.ts');
  });
});
