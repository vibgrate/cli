import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PyPICache } from '../src/core-open/scanners/pypi-cache.js';
import {
  pythonVersionFromPythonVersionFile,
  pythonVersionFromToolVersions,
  scanPythonProjects,
} from '../src/core-open/scanners/python-scanner.js';
import { latestStable } from '../src/core-open/runtimes/catalog.js';
import { BUNDLED_RUNTIME_CATALOG } from '../src/core-open/runtimes/snapshot.js';
import { FileCache } from '../src/core-open/utils/fs.js';
import { Semaphore } from '../src/core-open/utils/semaphore.js';

describe('Python runtime pin files', () => {
  let root: string;

  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('parses the first version line and skips non-version tokens', () => {
    expect(pythonVersionFromPythonVersionFile('\n\n# local pin\r\n3.12.4\r\n')).toBe('3.12.4');
    expect(pythonVersionFromPythonVersionFile('\uFEFF3.12.4\n')).toBe('3.12.4');
    expect(pythonVersionFromPythonVersionFile('system\n3.12.4\n')).toBeUndefined();
    expect(pythonVersionFromPythonVersionFile('myenv\n')).toBeUndefined();
    expect(pythonVersionFromToolVersions('nodejs 22.11.0\npython 3.12.4 3.11.9\n')).toBe('3.12.4');
    expect(pythonVersionFromToolVersions('python system\n')).toBeUndefined();
    expect(pythonVersionFromToolVersions('python system\npython 3.10.8 # fallback\n')).toBe('3.10.8');
  });

  for (const cached of [false, true]) {
    describe(cached ? 'with FileCache' : 'without FileCache', () => {
      it('reports .python-version 3.12.4 when the manifest declares no runtime', async () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-python-pin-'));
        fs.writeFileSync(path.join(root, 'requirements.txt'), 'requests==2.32.0\n');
        fs.writeFileSync(path.join(root, '.python-version'), '# pyenv\n\n3.12.4\n');
        fs.writeFileSync(path.join(root, '.tool-versions'), 'python 3.11.2\n');
        const cache = cached ? new FileCache() : undefined;
        const pypi = new PyPICache(new Semaphore(1), undefined, true);

        const projects = await scanPythonProjects(root, pypi, cache);
        expect(projects).toHaveLength(1);
        const project = projects[0]!;
        expect(project.runtime).toBe('3.12.4');
        const pyBase = latestStable(BUNDLED_RUNTIME_CATALOG, 'python')!;
        expect(project.runtimeLatest).toBe(`${pyBase.major}.${pyBase.minor}`);
        expect(project.runtimeMajorsBehind).toBe(
          pyBase.major === 3 ? Math.max(0, pyBase.minor - 12) : pyBase.minor + (pyBase.major - 3) * 10,
        );
      });

      it('uses .tool-versions when .python-version is absent or not a version', async () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-python-pin-'));
        const missingPin = path.join(root, 'missing-pin');
        const systemPin = path.join(root, 'system-pin');
        const venvPin = path.join(root, 'venv-pin');
        fs.mkdirSync(missingPin, { recursive: true });
        fs.mkdirSync(systemPin, { recursive: true });
        fs.mkdirSync(venvPin, { recursive: true });
        fs.writeFileSync(path.join(missingPin, 'requirements.txt'), 'requests==2.32.0\n');
        fs.writeFileSync(path.join(missingPin, '.tool-versions'), 'python 3.10.8\n');
        fs.writeFileSync(path.join(systemPin, 'requirements.txt'), 'requests==2.32.0\n');
        fs.writeFileSync(path.join(systemPin, '.python-version'), 'system\n');
        fs.writeFileSync(path.join(systemPin, '.tool-versions'), 'python 3.11.2\n');
        fs.writeFileSync(path.join(venvPin, 'requirements.txt'), 'requests==2.32.0\n');
        fs.writeFileSync(path.join(venvPin, '.python-version'), 'myenv\n');

        const cache = cached ? new FileCache() : undefined;
        const pypi = new PyPICache(new Semaphore(1), undefined, true);
        const projects = await scanPythonProjects(root, pypi, cache);
        const byPath = new Map(projects.map((project) => [project.path, project]));
        expect(byPath.get('missing-pin')?.runtime).toBe('3.10.8');
        expect(byPath.get('system-pin')?.runtime).toBe('3.11.2');
        expect(byPath.get('venv-pin')?.runtime).toBeUndefined();
      });

      it('keeps requires-python ahead of pin files', async () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-python-pin-'));
        fs.writeFileSync(path.join(root, 'pyproject.toml'), [
          '[project]',
          'name = "declared"',
          'requires-python = ">=3.11"',
          'dependencies = ["requests==2.32.0"]',
          '',
        ].join('\n'));
        fs.writeFileSync(path.join(root, '.python-version'), '3.12.4\n');
        fs.writeFileSync(path.join(root, '.tool-versions'), 'python 3.10.8\n');

        const cache = cached ? new FileCache() : undefined;
        const pypi = new PyPICache(new Semaphore(1), undefined, true);
        const projects = await scanPythonProjects(root, pypi, cache);
        expect(projects[0]!.runtime).toBe('>=3.11');
      });
    });
  }
});
