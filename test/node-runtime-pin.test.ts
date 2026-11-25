/**
 * When `engines.node` is absent, the Node runtime comes from `volta.node`,
 * `.nvmrc`, or `.node-version`. `engines.node` still wins when present, and an
 * unmappable pin leaves the runtime empty instead of guessing.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NpmCache } from '../src/core-open/scanners/npm-cache.js';
import { scanNodeProjects } from '../src/core-open/scanners/node-scanner.js';
import { latestLts } from '../src/core-open/runtimes/catalog.js';
import { BUNDLED_RUNTIME_CATALOG } from '../src/core-open/runtimes/snapshot.js';
import { FileCache } from '../src/core-open/utils/fs.js';
import { Semaphore } from '../src/core-open/utils/semaphore.js';

function nodeLag(runtime: string): { latest: string; behind: number } {
  const match = /^(\d+)/.exec(runtime);
  if (!match) throw new Error(`no node version in ${runtime}`);
  const latest = latestLts(BUNDLED_RUNTIME_CATALOG, 'nodejs');
  if (!latest) throw new Error('nodejs catalog has no released LTS cycle');
  return {
    latest: `${latest.major}.0.0`,
    behind: Math.max(0, latest.major - Number(match[1])),
  };
}

describe('Node runtime pin files', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
    roots.length = 0;
  });

  function makeRoot(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-node-pin-'));
    roots.push(root);
    return root;
  }

  function write(root: string, name: string, body: string): void {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  }

  async function scan(root: string, cache?: FileCache) {
    return scanNodeProjects(root, new NpmCache(root, new Semaphore(1), undefined, true), cache);
  }

  for (const cached of [false, true]) {
    describe(cached ? 'with FileCache' : 'without FileCache', () => {
      function cache(): FileCache | undefined {
        return cached ? new FileCache() : undefined;
      }

      it('reports .nvmrc v20.11.1 as runtime 20.11.1 with runtime lag', async () => {
        const root = makeRoot();
        write(root, 'package.json', JSON.stringify({ name: 'nvmrc-app' }));
        write(root, '.nvmrc', 'v20.11.1\n');

        const projects = await scan(root, cache());
        expect(projects).toHaveLength(1);
        const project = projects[0]!;
        expect(project.runtime).toBe('20.11.1');
        const lag = nodeLag('20.11.1');
        expect(project.runtimeLatest).toBe(lag.latest);
        expect(project.runtimeMajorsBehind).toBe(lag.behind);
        expect(project.runtimeMajorsBehind).toBeGreaterThan(0);
      });

      it('keeps engines.node ahead of volta and the pin files', async () => {
        const root = makeRoot();
        write(root, 'package.json', JSON.stringify({
          name: 'engines-app',
          engines: { node: '>=22' },
          volta: { node: '20.11.1' },
        }));
        write(root, '.nvmrc', '18.20.4\n');

        const projects = await scan(root, cache());
        expect(projects).toHaveLength(1);
        expect(projects[0]!.runtime).toBe('>=22');
      });

      it('uses volta.node ahead of .nvmrc', async () => {
        const root = makeRoot();
        write(root, 'package.json', JSON.stringify({
          name: 'volta-app',
          volta: { node: '20.11.1' },
        }));
        write(root, '.nvmrc', '18.20.4\n');

        const projects = await scan(root, cache());
        expect(projects).toHaveLength(1);
        expect(projects[0]!.runtime).toBe('20.11.1');
      });

      it('falls back to .node-version when .nvmrc cannot be mapped', async () => {
        const root = makeRoot();
        write(root, 'package.json', JSON.stringify({ name: 'node-version-app' }));
        write(root, '.nvmrc', 'system\n');
        write(root, '.node-version', 'v22.3.0\n');

        const projects = await scan(root, cache());
        expect(projects).toHaveLength(1);
        expect(projects[0]!.runtime).toBe('22.3.0');
      });

      it('accepts a bare major and an lts codename from .nvmrc', async () => {
        const root = makeRoot();
        write(root, 'major/package.json', JSON.stringify({ name: 'major-app' }));
        write(root, 'major/.nvmrc', '20\n');
        write(root, 'lts/package.json', JSON.stringify({ name: 'lts-app' }));
        write(root, 'lts/.nvmrc', 'lts/iron\n');

        const projects = await scan(root, cache());
        const byPath = new Map(projects.map((project) => [project.path, project.runtime]));
        expect(byPath.get('major')).toBe('20');
        expect(byPath.get('lts')).toBe('20');
      });

      it('leaves the runtime empty for an unmappable .nvmrc', async () => {
        const root = makeRoot();
        write(root, 'package.json', JSON.stringify({ name: 'unmapped-app' }));
        write(root, '.nvmrc', 'not-a-node-version\n');

        const projects = await scan(root, cache());
        expect(projects).toHaveLength(1);
        expect(projects[0]!.runtime).toBeUndefined();
        expect(projects[0]!.runtimeLatest).toBeUndefined();
        expect(projects[0]!.runtimeMajorsBehind).toBeUndefined();
      });
    });
  }
});
