/**
 * mix.exs tuples with keyword lists of any length are dependency rows.
 * `only:` is dev-only when every environment is :dev or :test.
 * `optional: true` is optionalDependencies, and a dev `only:` wins.
 * git / github / path / in_umbrella tuples are skipped.
 * Hex lookups and drift buckets stay on production rows.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const LATEST: Record<string, string> = {
  phoenix: '1.7.21',
  jason: '1.4.4',
  decimal: '2.3.0',
  plug: '1.17.0',
  ecto: '3.13.2',
  finch: '0.20.0',
  telemetry: '1.3.0',
  ranch: '2.2.0',
  cowboy: '2.12.0',
  absinthe: '1.7.8',
  hackney: '1.21.0',
  mint: '1.6.2',
  swoosh: '1.17.0',
};

const { fetchedNames, fetchHexVersionsBulk } = vi.hoisted(() => {
  const fetchedNames: string[][] = [];
  const latest: Record<string, string> = {
    phoenix: '1.7.21',
    jason: '1.4.4',
    decimal: '2.3.0',
    plug: '1.17.0',
    ecto: '3.13.2',
    finch: '0.20.0',
    telemetry: '1.3.0',
    ranch: '2.2.0',
    cowboy: '2.12.0',
    absinthe: '1.7.8',
    hackney: '1.21.0',
    mint: '1.6.2',
    swoosh: '1.17.0',
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

import { scanElixir } from '../src/core-open/scanners/elixir-scanner.js';

const DEV_NAMES = [
  'phoenix_live_reload',
  'floki',
  'credo',
  'dialyxir',
  'ex_doc',
  'sweet_xml',
  'excoveralls',
  'mox',
];

const SKIPPED_NAMES = [
  'dep_from_git',
  'dep_from_github',
  'dep_from_path',
  'sibling',
  'not_a_dep',
  'also_not',
  'nope',
];

function lockEntry(name: string, version: string): string {
  return `  "${name}": {:hex, :${name}, "${version}", "hash", [:mix], [], "hexpm", "hash"},`;
}

const LOCK = `%{
${lockEntry('phoenix', '1.7.14')}
${lockEntry('jason', '1.4.1')}
${lockEntry('decimal', '2.1.0')}
${lockEntry('plug', '1.16.1')}
${lockEntry('ecto', '3.11.2')}
${lockEntry('finch', '0.19.0')}
${lockEntry('telemetry', '0.4.3')}
${lockEntry('ranch', '1.8.0')}
${lockEntry('cowboy', '2.12.0')}
${lockEntry('absinthe', '1.7.6')}
${lockEntry('hackney', '1.20.1')}
${lockEntry('mint', '1.6.0')}
${lockEntry('credo', '1.7.7')}
${lockEntry('dialyxir', '1.4.3')}
${lockEntry('ex_doc', '0.34.2')}
${lockEntry('sweet_xml', '0.7.4')}
${lockEntry('dep_from_git', '0.1.0')}
}
`;

function mixExs(deps: string): string {
  return `defmodule Sample.MixProject do
  use Mix.Project

  @moduledoc """
  Example only. {:not_a_dep, "~> 9.9", optional: true}
  """

  def project do
    [
      app: :sample,
      version: "0.1.0",
      elixir: "~> 1.15",
      description: "uses {:nope, \\"1.0\\"}",
      deps: deps()
    ]
  end

  defp deps do
    [
${deps}
    ]
  end
end
`;
}

const FULL_DEPS = `
      {:phoenix, "~> 1.7"},
      {:phoenix_live_reload, "~> 1.5", only: :dev},
      {:floki, ">= 0.30.0", only: :test},
      {:credo, "~> 1.7", only: [:dev, :test], runtime: false},
      {:dialyxir, "~> 1.4",\r
        only: :dev,\r
        runtime: false},
      { :jason , "~> 1.4" , optional : true },
      {:decimal, "~> 2.0", optional: false},
      {:plug, "~> 1.16", only: [:dev, :prod]},
      {:ecto, "~> 3.11",
        optional: true},
      {:finch, "~> 0.19", runtime: false},
      {:telemetry, "~> 1.0"},
      {:ranch, "~> 1.8"},
      {:cowboy, "~> 2.10", only: :prod},
      {:absinthe, "~> 1.7", only: [:dev, :prod], runtime: false},
      {:hackney, "~> 1.20", optional: true, only: [:dev, :prod]},
      {:mint, "~> 1.6", only: []},
      {:swoosh, "~> 1.16"},
      {:ex_doc, "~> 0.34",
        only: [:dev, :test],
        runtime: false},
      {:sweet_xml, "~> 0.7", optional: true, only: :test},
      {:excoveralls, "~> 0.18", only: [:dev], optional: true},
      {:mox, "~> 1.1", only: :test, optional: false},
      {:dep_from_git, git: "https://github.com/elixir-lang/my_dep.git", tag: "0.1.0"},
      {:dep_from_github, github: "elixir-lang/my_dep", tag: "v1.0.0"},
      {:dep_from_path, path: "../my_dep"},
      {:sibling, in_umbrella: true},
      # {:also_not, "~> 8.0", only: :dev}
`;

const PROD_DEPS = `
      {:phoenix, "~> 1.7"},
      { :jason , "~> 1.4" , optional : true },
      {:decimal, "~> 2.0", optional: false},
      {:plug, "~> 1.16", only: [:dev, :prod]},
      {:ecto, "~> 3.11",
        optional: true},
      {:finch, "~> 0.19", runtime: false},
      {:telemetry, "~> 1.0"},
      {:ranch, "~> 1.8"},
      {:cowboy, "~> 2.10", only: :prod},
      {:absinthe, "~> 1.7", only: [:dev, :prod], runtime: false},
      {:hackney, "~> 1.20", optional: true, only: [:dev, :prod]},
      {:mint, "~> 1.6", only: []},
      {:swoosh, "~> 1.16"},
`;

const PROD_NAMES = [
  'phoenix',
  'jason',
  'decimal',
  'plug',
  'ecto',
  'finch',
  'telemetry',
  'ranch',
  'cowboy',
  'absinthe',
  'hackney',
  'mint',
  'swoosh',
];

describe('mix.exs dependency tuples', () => {
  const roots: string[] = [];

  afterEach(() => {
    fetchedNames.length = 0;
    fetchHexVersionsBulk.mockClear();
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
    roots.length = 0;
  });

  async function scan(deps: string, lock = LOCK) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-mix-exs-'));
    roots.push(root);
    fs.writeFileSync(path.join(root, 'mix.exs'), mixExs(deps));
    fs.writeFileSync(path.join(root, 'mix.lock'), lock);
    const project = await scanElixir(root, undefined, undefined, true);
    expect(project).not.toBeNull();
    return project!;
  }

  it('reads keyword lists, maps optional and dev, and skips non-hex sources', async () => {
    const project = await scan(FULL_DEPS);
    expect(project.runtime).toBe('~> 1.15');

    const byPackage = new Map(project.dependencies.map((dep) => [dep.package, dep]));
    expect(project.dependencies.map((dep) => dep.package)).toEqual([
      'phoenix',
      'phoenix_live_reload',
      'floki',
      'credo',
      'dialyxir',
      'jason',
      'decimal',
      'plug',
      'ecto',
      'finch',
      'telemetry',
      'ranch',
      'cowboy',
      'absinthe',
      'hackney',
      'mint',
      'swoosh',
      'ex_doc',
      'sweet_xml',
      'excoveralls',
      'mox',
    ]);

    expect(byPackage.get('phoenix')?.section).toBe('dependencies');
    expect(byPackage.get('phoenix')?.currentSpec).toBe('~> 1.7');
    expect(byPackage.get('jason')?.section).toBe('optionalDependencies');
    expect(byPackage.get('decimal')?.section).toBe('dependencies');
    expect(byPackage.get('plug')?.section).toBe('dependencies');
    expect(byPackage.get('ecto')?.section).toBe('optionalDependencies');
    expect(byPackage.get('finch')?.section).toBe('dependencies');
    expect(byPackage.get('cowboy')?.section).toBe('dependencies');
    expect(byPackage.get('absinthe')?.section).toBe('dependencies');
    expect(byPackage.get('hackney')?.section).toBe('optionalDependencies');
    expect(byPackage.get('mint')?.section).toBe('dependencies');
    expect(byPackage.get('swoosh')?.section).toBe('dependencies');

    for (const name of DEV_NAMES) {
      expect(byPackage.get(name)?.section).toBe('devDependencies');
      expect(byPackage.get(name)?.latestStable).toBeNull();
      expect(byPackage.get(name)?.majorsBehind).toBeNull();
      expect(byPackage.get(name)?.drift).toBe('unknown');
    }
    expect(byPackage.get('credo')?.resolvedVersion).toBe('1.7.7');
    expect(byPackage.get('dialyxir')?.resolvedVersion).toBe('1.4.3');
    expect(byPackage.get('ex_doc')?.currentSpec).toBe('~> 0.34');
    expect(byPackage.get('sweet_xml')?.currentSpec).toBe('~> 0.7');

    for (const name of SKIPPED_NAMES) expect(byPackage.has(name)).toBe(false);

    expect(fetchedNames).toEqual([PROD_NAMES]);
    expect(fetchHexVersionsBulk).toHaveBeenCalledTimes(1);

    const prod = project.dependencies.filter((dep) => dep.section !== 'devDependencies');
    expect(prod.map((dep) => dep.package)).toEqual(PROD_NAMES);
    const buckets = project.dependencyAgeBuckets;
    expect(buckets.current + buckets.oneBehind + buckets.twoPlusBehind + buckets.unknown).toBe(prod.length);

    expect(byPackage.get('cowboy')).toMatchObject({
      section: 'dependencies',
      resolvedVersion: '2.12.0',
      latestStable: LATEST.cowboy,
      majorsBehind: 0,
      drift: 'current',
    });
    expect(byPackage.get('telemetry')).toMatchObject({
      section: 'dependencies',
      resolvedVersion: '0.4.3',
      latestStable: LATEST.telemetry,
      majorsBehind: 1,
      drift: 'major-behind',
    });
    expect(byPackage.get('jason')).toMatchObject({
      section: 'optionalDependencies',
      resolvedVersion: '1.4.1',
      latestStable: LATEST.jason,
      majorsBehind: 0,
      drift: 'minor-behind',
    });
    expect(byPackage.get('hackney')?.latestStable).toBe(LATEST.hackney);

    const frameworkNames = project.frameworks.map((framework) => framework.name);
    expect(frameworkNames).toContain('phoenix');
    expect(frameworkNames).toContain('jason');
    expect(frameworkNames).toContain('ecto');
    expect(frameworkNames).not.toContain('credo');
    expect(frameworkNames).not.toContain('dialyxir');
  });

  it('keeps production drift buckets the same when development rows are present', async () => {
    const full = await scan(FULL_DEPS);
    const prodOnly = await scan(PROD_DEPS);
    expect(full.dependencyAgeBuckets).toEqual(prodOnly.dependencyAgeBuckets);

    const fullProd = full.dependencies.filter((dep) => dep.section !== 'devDependencies');
    expect(fullProd).toEqual(prodOnly.dependencies);
    expect(fetchedNames[0]).toEqual(PROD_NAMES);
    expect(fetchedNames[1]).toEqual(PROD_NAMES);
    for (const names of fetchedNames) {
      for (const dev of DEV_NAMES) expect(names).not.toContain(dev);
    }
  });
});
