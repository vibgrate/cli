import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PyPICache } from '../src/core-open/scanners/pypi-cache.js';
import { scanPythonProjects } from '../src/core-open/scanners/python-scanner.js';
import { FileCache } from '../src/core-open/utils/fs.js';
import { Semaphore } from '../src/core-open/utils/semaphore.js';

describe('Python runtime from a Pipfile [requires] table', () => {
  let root: string;

  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  for (const cached of [false, true]) {
    describe(cached ? 'with FileCache' : 'without FileCache', () => {
      it('reports python_version from a Pipfile-only project', async () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-pipfile-runtime-'));
        fs.writeFileSync(path.join(root, 'Pipfile'), [
          '[[source]]',
          'url = "https://pypi.org/simple"',
          '',
          '[packages]',
          '',
          '[requires]',
          'python_version = "3.11"',
          '',
        ].join('\n'));
        const cache = cached ? new FileCache() : undefined;
        const pypi = new PyPICache(new Semaphore(1), undefined, true);

        const projects = await scanPythonProjects(root, pypi, cache);

        expect(projects).toHaveLength(1);
        expect(projects[0]!.runtime).toBe('3.11');
      });

      it('prefers python_full_version when both keys are set', async () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-pipfile-runtime-'));
        fs.writeFileSync(path.join(root, 'Pipfile'), [
          '[packages]',
          '',
          '[requires]',
          'python_version = "3.11"',
          'python_full_version = "3.11.6"',
          '',
        ].join('\n'));
        const cache = cached ? new FileCache() : undefined;
        const pypi = new PyPICache(new Semaphore(1), undefined, true);

        const projects = await scanPythonProjects(root, pypi, cache);

        expect(projects).toHaveLength(1);
        expect(projects[0]!.runtime).toBe('3.11.6');
      });

      it('keeps requires-python from pyproject.toml ahead of the Pipfile', async () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-pipfile-runtime-'));
        const declared = path.join(root, 'declared');
        const pipfileOnly = path.join(root, 'pipfile-only');
        fs.mkdirSync(declared);
        fs.mkdirSync(pipfileOnly);
        fs.writeFileSync(path.join(declared, 'pyproject.toml'), [
          '[project]',
          'name = "declared"',
          'requires-python = ">=3.12"',
          '',
        ].join('\n'));
        for (const dir of [declared, pipfileOnly]) {
          fs.writeFileSync(path.join(dir, 'Pipfile'), [
            '[packages]',
            '',
            '[requires]',
            'python_version = "3.11"',
            '',
          ].join('\n'));
        }
        const cache = cached ? new FileCache() : undefined;
        const pypi = new PyPICache(new Semaphore(1), undefined, true);

        const projects = await scanPythonProjects(root, pypi, cache);
        const byPath = new Map(projects.map((project) => [project.path, project]));

        expect(projects).toHaveLength(2);
        expect(byPath.get('declared')?.runtime).toBe('>=3.12');
        expect(byPath.get('pipfile-only')?.runtime).toBe('3.11');
      });

      it('leaves a Pipfile without a [requires] table on the pin-file fallback', async () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-pipfile-runtime-'));
        const noRequires = path.join(root, 'no-requires');
        const withRequires = path.join(root, 'with-requires');
        fs.mkdirSync(noRequires);
        fs.mkdirSync(withRequires);
        fs.writeFileSync(path.join(noRequires, 'Pipfile'), [
          '[packages]',
          'requests = "==2.31.0"',
          '',
          '[dev-packages]',
          'pytest = "==8.2.0"',
          '',
        ].join('\n'));
        fs.writeFileSync(path.join(noRequires, '.python-version'), '3.10.8\n');
        fs.writeFileSync(path.join(withRequires, 'Pipfile'), [
          '[packages]',
          '',
          '[requires]',
          'python_version = "3.11"',
          '',
        ].join('\n'));
        fs.writeFileSync(path.join(withRequires, '.python-version'), '3.10.8\n');
        const cache = cached ? new FileCache() : undefined;
        const pypi = new PyPICache(new Semaphore(1), undefined, true);

        const projects = await scanPythonProjects(root, pypi, cache);
        const byPath = new Map(projects.map((project) => [project.path, project]));

        expect(projects).toHaveLength(2);
        const unchanged = byPath.get('no-requires')!;
        expect(unchanged.runtime).toBe('3.10.8');
        expect(unchanged.dependencies.map((dep) => dep.package)).toEqual(['pytest', 'requests']);
        expect(byPath.get('with-requires')?.runtime).toBe('3.11');
      });
    });
  }
});
