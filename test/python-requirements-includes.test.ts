/**
 * Requirements includes (`-r` / `--requirement`) and constraints
 * (`-c` / `--constraint`). Included files are read relative to the file
 * that names them. A constraint file supplies versions only.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PyPICache } from '../src/core-open/scanners/pypi-cache.js';
import { scanPythonProjects } from '../src/core-open/scanners/python-scanner.js';
import { FileCache } from '../src/core-open/utils/fs.js';
import { Semaphore } from '../src/core-open/utils/semaphore.js';
import type { ProjectScan } from '../src/reporting/types.js';

interface ListedDep {
  package: string;
  section: string;
  currentSpec: string;
  resolvedVersion: string | null;
}

function listed(project: ProjectScan): ListedDep[] {
  return project.dependencies
    .map((dep) => ({
      package: dep.package,
      section: dep.section,
      currentSpec: dep.currentSpec,
      resolvedVersion: dep.resolvedVersion,
    }))
    .sort((a, b) => (a.package < b.package ? -1 : a.package > b.package ? 1 : 0));
}

describe('Python requirements includes and constraints', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
    roots.length = 0;
  });

  function makeRoot(prefix: string): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    roots.push(root);
    return root;
  }

  async function scan(root: string, cached: boolean): Promise<ProjectScan[]> {
    const cache = cached ? new FileCache() : undefined;
    const pypi = new PyPICache(new Semaphore(1), undefined, true);
    const projects = await scanPythonProjects(root, pypi, cache);
    expect(await scanPythonProjects(root, pypi, cache)).toEqual(projects);
    return projects;
  }

  function write(root: string, rel: string, body: string): void {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  }

  for (const cached of [false, true]) {
    describe(cached ? 'with FileCache' : 'without FileCache', () => {
      it('reports packages from a split requirements layout', async () => {
        const root = makeRoot('vg-py-req-split-');
        write(
          root,
          'requirements.txt',
          [
            '# runtime',
            '-r requirements/base.txt  # shared runtime',
            '--requirement requirements/prod.txt',
            '--index-url https://pypi.org/simple',
            '-e .',
          ].join('\r\n') + '\r\n',
        );
        write(root, 'requirements/base.txt', 'requests==2.31.0\n');
        write(root, 'requirements/prod.txt', 'flask==2.3.3\n');

        const projects = await scan(root, cached);
        expect(projects).toHaveLength(1);
        expect(listed(projects[0]!)).toEqual([
          { package: 'flask', section: 'dependencies', currentSpec: '==2.3.3', resolvedVersion: '2.3.3' },
          { package: 'requests', section: 'dependencies', currentSpec: '==2.31.0', resolvedVersion: '2.31.0' },
        ]);
      });

      it('follows every requirement-file form, including a nested relative path', async () => {
        const root = makeRoot('vg-py-req-forms-');
        const base = path.join(root, 'requirements', 'my files', 'base.txt');
        write(root, 'requirements.txt', [
          `-r${path.join('requirements', 'direct.txt')}`,
          '--requirement requirements/prod.txt',
          `--requirement=${path.join('requirements', 'extra.txt')}`,
          `-r "${path.relative(root, base)}"`,
          `-r ${path.join(root, 'requirements', 'abs-inside.txt')}`,
        ].join('\n') + '\n');
        write(root, 'requirements/direct.txt', 'requests==2.31.0\n');
        write(root, 'requirements/prod.txt', 'flask==2.3.3\n-r nested/more.txt\n');
        write(root, 'requirements/nested/more.txt', 'django==4.2.11\n');
        write(root, 'requirements/extra.txt', 'numpy==1.26.4\n');
        write(root, 'requirements/my files/base.txt', 'celery==5.3.6\n');
        write(root, 'requirements/abs-inside.txt', 'redis==5.0.1\n');

        const projects = await scan(root, cached);
        expect(projects).toHaveLength(1);
        expect(listed(projects[0]!).map((dep) => dep.package)).toEqual([
          'celery',
          'django',
          'flask',
          'numpy',
          'redis',
          'requests',
        ]);
      });

      it('stops on an include cycle and reports each package once', async () => {
        const root = makeRoot('vg-py-req-cycle-');
        write(root, 'requirements.txt', '-r requirements/a.txt\n-r ./requirements.txt\nrich==13.7.1\n');
        write(root, 'requirements/a.txt', 'flask==2.3.3\nrequests==2.31.0\n-r b.txt\n-r ../requirements.txt\n');
        write(root, 'requirements/b.txt', 'django==4.2.11\nrequests==2.31.0\n-r a.txt\n-r b.txt\n');

        const projects = await scan(root, cached);
        expect(projects).toHaveLength(1);
        expect(listed(projects[0]!).map((dep) => [dep.package, dep.currentSpec])).toEqual([
          ['django', '==4.2.11'],
          ['flask', '==2.3.3'],
          ['requests', '==2.31.0'],
          ['rich', '==13.7.1'],
        ]);
      });

      it('uses a constraint pin for an unpinned requirement and adds no constraint-only rows', async () => {
        const root = makeRoot('vg-py-req-constraint-');
        write(root, 'requirements.txt', [
          '-c constraints.txt',
          '-cconstraints/glued.txt',
          '--constraint constraints/more.txt',
          '--constraint=constraints/eq.txt',
          'flask',
          'requests[security]',
          'SQLAlchemy',
          'django>=4.2',
          'numpy==1.26.4',
        ].join('\n') + '\n');
        write(root, 'constraints.txt', [
          'flask==2.3.3 ; python_version >= "3.8"',
          'django==4.2.16',
          'numpy==9.9.9',
          'only_in_constraints==1.0.0',
          '-c constraints/nested.txt',
        ].join('\n') + '\n');
        write(root, 'constraints/glued.txt', 'requests==2.31.0\n');
        write(root, 'constraints/more.txt', 'sqlalchemy==2.0.30\n');
        write(root, 'constraints/eq.txt', 'extra==9.9.9\n');
        write(root, 'constraints/nested.txt', '-r also.txt\n');
        write(root, 'constraints/also.txt', 'also_only==3.1.4\n');

        const projects = await scan(root, cached);
        expect(projects).toHaveLength(1);
        expect(listed(projects[0]!)).toEqual([
          { package: 'SQLAlchemy', section: 'dependencies', currentSpec: '==2.0.30', resolvedVersion: '2.0.30' },
          { package: 'django', section: 'dependencies', currentSpec: '>=4.2', resolvedVersion: null },
          { package: 'flask', section: 'dependencies', currentSpec: '==2.3.3', resolvedVersion: '2.3.3' },
          { package: 'numpy', section: 'dependencies', currentSpec: '==1.26.4', resolvedVersion: '1.26.4' },
          { package: 'requests', section: 'dependencies', currentSpec: '==2.31.0', resolvedVersion: '2.31.0' },
        ]);
      });

      it('keeps the top-level file classification for included files', async () => {
        const root = makeRoot('vg-py-req-dev-include-');
        write(root, 'requirements.txt', '-r requirements/prod.txt\n');
        write(root, 'requirements-dev.txt', '-r requirements/tools.txt\n');
        write(root, 'requirements/prod.txt', '-r common.txt\nrequests==2.31.0\n');
        write(root, 'requirements/tools.txt', '-r common.txt\n-r lint.txt\npytest==8.2.0\n');
        write(root, 'requirements/common.txt', 'shared==1.2.0\n');
        write(root, 'requirements/lint.txt', 'ruff==0.6.9\n');
        // The included file's own name would classify as dev. The top-level
        // manifest is requirements.txt, so the package stays production.
        write(root, 'requirements/dev.txt', 'coverage==7.6.0\n');
        fs.appendFileSync(path.join(root, 'requirements.txt'), '-r requirements/dev.txt\n');

        const projects = await scan(root, cached);
        expect(projects).toHaveLength(1);
        expect(listed(projects[0]!)).toEqual([
          { package: 'coverage', section: 'dependencies', currentSpec: '==7.6.0', resolvedVersion: '7.6.0' },
          { package: 'pytest', section: 'devDependencies', currentSpec: '==8.2.0', resolvedVersion: '8.2.0' },
          { package: 'requests', section: 'dependencies', currentSpec: '==2.31.0', resolvedVersion: '2.31.0' },
          { package: 'ruff', section: 'devDependencies', currentSpec: '==0.6.9', resolvedVersion: '0.6.9' },
          { package: 'shared', section: 'dependencies', currentSpec: '==1.2.0', resolvedVersion: '1.2.0' },
        ]);
      });

      it('skips missing, unreadable, and out-of-root includes', async () => {
        const parent = makeRoot('vg-py-req-escape-');
        const root = path.join(parent, 'proj');
        fs.mkdirSync(root);
        const outside = path.join(parent, 'outside.txt');
        fs.writeFileSync(outside, 'stolen==9.9.9\n');
        fs.mkdirSync(path.join(root, 'requirements', 'not-a-file'), { recursive: true });
        fs.symlinkSync(outside, path.join(root, 'escape.txt'));
        write(root, 'requirements.txt', [
          '-r requirements/missing.txt',
          '-r requirements/not-a-file',
          '-r ../outside.txt',
          `-r ${outside}`,
          '-r escape.txt',
          'requests==2.31.0',
        ].join('\n') + '\n');

        const projects = await scan(root, cached);
        expect(projects).toHaveLength(1);
        expect(listed(projects[0]!).map((dep) => dep.package)).toEqual(['requests']);
      });

      it('follows a symlink that stays inside the scan root', async () => {
        const root = makeRoot('vg-py-req-symlink-');
        write(root, 'requirements/base.txt', 'flask==2.3.3\n');
        fs.symlinkSync(path.join(root, 'requirements', 'base.txt'), path.join(root, 'requirements', 'link.txt'));
        write(root, 'requirements.txt', '-r requirements/link.txt\n');

        const projects = await scan(root, cached);
        expect(projects).toHaveLength(1);
        expect(listed(projects[0]!).map((dep) => [dep.package, dep.currentSpec])).toEqual([
          ['flask', '==2.3.3'],
        ]);
      });
    });
  }
});
