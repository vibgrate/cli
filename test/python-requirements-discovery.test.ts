import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PyPICache } from '../src/core-open/scanners/pypi-cache.js';
import { scanPythonProjects } from '../src/core-open/scanners/python-scanner.js';
import { FileCache } from '../src/core-open/utils/fs.js';
import { Semaphore } from '../src/core-open/utils/semaphore.js';

describe('Python requirements file discovery and parsing', () => {
  let root: string;

  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  for (const cached of [false, true]) {
    describe(cached ? 'with FileCache' : 'without FileCache', () => {
      it.each([
        'dev-requirements.txt',
        'requirements.txt',
        'requirements-dev.txt',
        'requirements_dev.txt',
        'requirements-test.txt',
        'requirements-ci.txt',
      ])('scans a project whose only manifest is %s', async (fileName) => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-python-requirements-'));
        fs.writeFileSync(path.join(root, fileName), 'pytest==8.2.0\nrequests==2.31.0\n');
        const cache = cached ? new FileCache() : undefined;
        const pypi = new PyPICache(new Semaphore(1), undefined, true);

        const projects = await scanPythonProjects(root, pypi, cache);

        expect(projects).toHaveLength(1);
        expect(projects[0]!.dependencies).toEqual([
          expect.objectContaining({ package: 'pytest', currentSpec: '==8.2.0', resolvedVersion: '8.2.0' }),
          expect.objectContaining({ package: 'requests', currentSpec: '==2.31.0', resolvedVersion: '2.31.0' }),
        ]);
        expect(await scanPythonProjects(root, pypi, cache)).toEqual(projects);
      });
    });
  }
});
