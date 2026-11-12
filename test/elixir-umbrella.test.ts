/**
 * Umbrella `in_umbrella: true` and `path:` tuples stay off the Hex rows.
 * When the target is another scanned Mix project, it is a project reference
 * relative to the scan root. `apps_path` defaults to `apps`.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

const LATEST: Record<string, string> = {
  plug: '1.17.0',
  jason: '1.4.4',
  decimal: '2.3.0',
};

const { fetchedNames, fetchHexVersionsBulk } = vi.hoisted(() => {
  const fetchedNames: string[][] = [];
  const latest: Record<string, string> = {
    plug: '1.17.0',
    jason: '1.4.4',
    decimal: '2.3.0',
  };
  const fetchHexVersionsBulk = vi.fn(async (names: string[]) => {
    fetchedNames.push([...names]);
    const results = new Map<string, string>();
    for (const name of names) {
      const version = latest[name];
      if (version) results.set(name, version);
    }
    return results;
  });
  return { fetchedNames, fetchHexVersionsBulk };
});

vi.mock('../src/core-open/scanners/hex-cache.js', () => ({
  fetchHexVersionsBulk,
}));

import { scanElixirProjects } from '../src/core-open/scanners/elixir-scanner.js';
import { FileCache } from '../src/core-open/utils/fs.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/elixir-umbrella/', import.meta.url));
const LOCAL_NAMES = ['core', 'side', 'missing', 'dep_from_git'];

function copyTree(src: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-elixir-umbrella-'));
  fs.cpSync(src, root, { recursive: true });
  return root;
}

function writeMix(dir: string, body: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'mix.exs'), body);
}

describe('elixir umbrella project references', () => {
  const roots: string[] = [];

  afterEach(() => {
    fetchedNames.length = 0;
    fetchHexVersionsBulk.mockClear();
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
    roots.length = 0;
  });

  async function scan(root: string) {
    roots.push(root);
    return scanElixirProjects(root, undefined, new FileCache(), undefined, true);
  }

  it('links in_umbrella and path targets that were scanned and leaves Hex drift unchanged', async () => {
    const projects = await scan(copyTree(FIXTURE));
    const byPath = new Map(projects.map((project) => [project.path, project]));

    expect([...byPath.keys()].sort()).toEqual(['.', 'apps/core', 'apps/web', 'side']);

    const web = byPath.get('apps/web')!;
    expect(web.projectReferences).toEqual([
      { path: 'apps/core', name: 'core', refType: 'workspace' },
      { path: 'side', name: 'side', refType: 'workspace' },
    ]);
    expect(web.dependencies.map((dep) => dep.package)).toEqual(['plug']);
    expect(web.dependencies[0]).toMatchObject({
      section: 'dependencies',
      currentSpec: '~> 1.16',
      resolvedVersion: '1.16.1',
      latestStable: LATEST.plug,
      majorsBehind: 0,
      drift: 'minor-behind',
    });
    expect(web.dependencyAgeBuckets).toEqual({
      current: 0,
      oneBehind: 0,
      twoPlusBehind: 0,
      unknown: 1,
    });

    const core = byPath.get('apps/core')!;
    expect(core.projectReferences).toBeUndefined();
    expect(core.dependencies.map((dep) => dep.package)).toEqual(['jason']);
    expect(core.dependencies[0]).toMatchObject({
      resolvedVersion: '1.4.1',
      latestStable: LATEST.jason,
      majorsBehind: 0,
      drift: 'minor-behind',
    });
    expect(core.dependencyAgeBuckets).toEqual(web.dependencyAgeBuckets);

    const side = byPath.get('side')!;
    expect(side.projectReferences).toBeUndefined();
    expect(side.dependencies.map((dep) => dep.package)).toEqual(['decimal']);
    expect(side.dependencies[0]).toMatchObject({
      resolvedVersion: '2.1.0',
      latestStable: LATEST.decimal,
      majorsBehind: 0,
      drift: 'minor-behind',
    });
    expect(side.dependencyAgeBuckets).toEqual(web.dependencyAgeBuckets);

    const root = byPath.get('.')!;
    expect(root.projectReferences).toBeUndefined();
    expect(root.dependencies).toEqual([]);
    expect(root.dependencyAgeBuckets).toEqual({
      current: 0,
      oneBehind: 0,
      twoPlusBehind: 0,
      unknown: 0,
    });

    expect(fetchedNames.flat().sort()).toEqual(['decimal', 'jason', 'plug']);
    for (const names of fetchedNames) {
      for (const local of LOCAL_NAMES) expect(names).not.toContain(local);
    }
  });

  it('resolves in_umbrella through a declared apps_path and ignores a path that is not scanned', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-elixir-apps-path-'));
    writeMix(root, `defmodule Umbrella.MixProject do
  use Mix.Project

  def project do
    [
      apps_path: "services",
      elixir: "~> 1.15",
      deps: deps()
    ]
  end

  defp deps do
    []
  end
end
`);
    writeMix(path.join(root, 'services', 'web'), `defmodule Web.MixProject do
  use Mix.Project

  def project do
    [
      app: :web,
      elixir: "~> 1.15",
      deps: deps()
    ]
  end

  defp deps do
    [
      {:core, in_umbrella: true},
      {:plug, "~> 1.16"},
      {:gone, path: "../gone"}
    ]
  end
end
`);
    writeMix(path.join(root, 'services', 'core'), `defmodule Core.MixProject do
  use Mix.Project

  def project do
    [
      app: :core,
      elixir: "~> 1.15",
      deps: deps()
    ]
  end

  defp deps do
    []
  end
end
`);

    const projects = await scan(root);
    const web = projects.find((project) => project.path === 'services/web');
    expect(web?.projectReferences).toEqual([
      { path: 'services/core', name: 'core', refType: 'workspace' },
    ]);
    expect(web?.dependencies.map((dep) => dep.package)).toEqual(['plug']);
    expect(projects.find((project) => project.path === 'services/core')?.projectReferences).toBeUndefined();
    expect(fetchedNames.flat()).toEqual(['plug']);
  });

  it('does not use the default apps directory when apps_path names another directory', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-elixir-apps-mismatch-'));
    writeMix(root, `defmodule Umbrella.MixProject do
  use Mix.Project

  def project do
    [
      apps_path: "services",
      deps: deps()
    ]
  end

  defp deps do
    []
  end
end
`);
    writeMix(path.join(root, 'apps', 'web'), `defmodule Web.MixProject do
  use Mix.Project

  defp deps do
    [
      {:core, in_umbrella: true}
    ]
  end
end
`);
    writeMix(path.join(root, 'apps', 'core'), `defmodule Core.MixProject do
  use Mix.Project

  defp deps do
    []
  end
end
`);

    const projects = await scan(root);
    const web = projects.find((project) => project.path === 'apps/web');
    expect(web?.projectReferences).toBeUndefined();
    expect(web?.dependencies).toEqual([]);
    expect(fetchedNames.flat()).toEqual([]);
  });
});
