/**
 * mix.exs Hex tuples keep keyword lists of any length. `only:` is dev when
 * every environment is `:dev` or `:test`. `optional: true` is an optional
 * row, and a dev row stays dev when it is also optional. Drift buckets and
 * Hex lookups stay on production rows.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseMixExs, scanElixir } from '../src/core-open/scanners/elixir-scanner.js';
import * as hexCache from '../src/core-open/scanners/hex-cache.js';
import type { PackageVersionManifest } from '../src/core-open/package-version-manifest.js';
import { collectLockfileGraph, toCycloneDx, toSpdx } from '../src/reporting/commands/sbom.js';
import type { ProjectScan, ScanArtifact } from '../src/reporting/types.js';

const FIVE_TUPLES = `
defmodule App.MixProject do
  use Mix.Project

  def project do
    [
      app: :app,
      version: "0.1.0",
      elixir: "~> 1.15",
      deps: deps()
    ]
  end

  defp deps do
    [
      {:phoenix, "~> 1.7.0"},
      {:credo, "~> 1.7", only: [:dev, :test], runtime: false},
      {:dialyxir, "~> 1.4", only: :dev, runtime: false},
      {:jason, "~> 1.4", optional: true},
      {:ex_doc, "~> 0.31", only: :dev}
    ]
  end
end
`;

const MANIFEST: PackageVersionManifest = {
  hex: {
    phoenix: { latest: '2.1.0' },
    jason: { latest: '1.4.4' },
    plain: { latest: '1.0.0' },
    bare: { latest: '2.0.0' },
    both: { latest: '1.0.0' },
    credo: { latest: '9.9.9' },
    dialyxir: { latest: '9.9.9' },
    x: { latest: '9.9.9' },
  },
};

function artifact(projects: ProjectScan[]): ScanArtifact {
  return {
    schemaVersion: '1.0',
    timestamp: '2026-02-19T00:00:00.000Z',
    vibgrateVersion: '0.0.1',
    rootPath: 'elixir-mix',
    drift: {
      score: 0,
      riskLevel: 'low',
      components: { runtimeScore: 0, frameworkScore: 0, dependencyScore: 0, eolScore: 0 },
    },
    findings: [],
    projects,
  };
}

describe('parseMixExs', () => {
  it('keeps the five common tuples and classifies dev versus production', () => {
    const parsed = parseMixExs(FIVE_TUPLES);
    expect(parsed.elixirVersion).toBe('~> 1.15');
    expect(parsed.deps.map((dep) => [dep.name, dep.isDev, dep.optional])).toEqual([
      ['phoenix', false, false],
      ['credo', true, false],
      ['dialyxir', true, false],
      ['jason', false, true],
      ['ex_doc', true, false],
    ]);
  });

  it('reads a tuple whose options start on the next line', () => {
    const parsed = parseMixExs(`
      defp deps do
        [
          {:wallaby, "~> 0.30",
            only: :test,
            runtime: false},
          {:credo, "~> 1.7",
            only: [:dev, :test],
            runtime: false}
        ]
      end
    `);
    expect(parsed.deps.map((dep) => [dep.name, dep.isDev])).toEqual([
      ['wallaby', true],
      ['credo', true],
    ]);
  });

  it('keeps only: [:dev, :prod] and only: [:prod] as production', () => {
    const parsed = parseMixExs(`
      [
        {:both, "~> 1.0", only: [:dev, :prod]},
        {:prod_list, "~> 1.0", only: [:prod]},
        {:prod_atom, "~> 1.0", only: :prod},
        {:tests, "~> 1.0", only: [:test]},
        {:tools, "~> 1.0", runtime: false, only: [:dev]}
      ]
    `);
    expect(parsed.deps.map((dep) => [dep.name, dep.isDev])).toEqual([
      ['both', false],
      ['prod_list', false],
      ['prod_atom', false],
      ['tests', true],
      ['tools', true],
    ]);
  });

  it('skips git, path, and in_umbrella dependencies', () => {
    const parsed = parseMixExs(`
      [
        {:phoenix, "~> 1.7.0"},
        {:my_git, git: "https://github.com/user/repo.git", tag: "v1.0.0"},
        {:forked, "~> 1.2", git: "https://github.com/user/repo.git"},
        {:my_path, path: "../my_path"},
        {:local, "~> 0.1", path: "../local"},
        {:my_umb, in_umbrella: true},
        {:quoted, "~> 1.0", organization: "acme}inc"},
        {:next, "~> 2.0"}
      ]
    `);
    expect(parsed.deps.map((dep) => dep.name)).toEqual(['phoenix', 'quoted', 'next']);
  });

  it.each([
    ['{:jason, "~> 1.4", optional: true}', false, true],
    ['{:x, "~> 1.0", only: :test, optional: true}', true, true],
    ['{:y, "~> 1.0", optional: true, only: :dev}', true, true],
    ['{:plain, "~> 1.0", optional: false}', false, false],
    ['{:bare, "~> 2.0"}', false, false],
  ] as const)('classifies %s', (tuple, isDev, optional) => {
    const parsed = parseMixExs(`defp deps do\n  [${tuple}]\nend\n`);
    expect(parsed.deps).toEqual([{ name: tuple.match(/:(\w+)/)![1], version: tuple.match(/"([^"]+)"/)![1], isDev, optional }]);
  });
});

describe('scanElixir mix.exs sections', () => {
  let root: string;

  afterEach(() => {
    vi.restoreAllMocks();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  const MIX = `defmodule App.MixProject do
  use Mix.Project
  def project do
    [app: :app, version: "0.1.0", elixir: "~> 1.15", deps: deps()]
  end
  defp deps do
    [
      {:phoenix, "~> 1.7.0"},
      {:jason, "~> 1.4", optional: true},
      {:plain, "~> 1.0", optional: false},
      {:bare, "~> 2.0"},
      {:both, "~> 1.0", only: [:dev, :prod]},
      {:x, "~> 1.0", only: :test, optional: true},
      {:credo, "~> 1.7", only: [:dev, :test], runtime: false},
      {:dialyxir, "~> 1.4",
        only: :dev,
        runtime: false},
      {:my_git, git: "https://github.com/user/repo.git", tag: "v1.0.0"},
      {:my_path, path: "../my_path"},
      {:my_umb, in_umbrella: true}
    ]
  end
end
`;

  const LOCK = `{
  "bare": {:hex, :bare, "2.0.0", "aaa", [:mix], "hexpm", "bbb"},
  "both": {:hex, :both, "1.0.0", "aaa", [:mix], "hexpm", "bbb"},
  "credo": {:hex, :credo, "1.7.6", "aaa", [:mix], "hexpm", "bbb"},
  "dialyxir": {:hex, :dialyxir, "1.4.3", "aaa", [:mix], "hexpm", "bbb"},
  "jason": {:hex, :jason, "1.4.1", "aaa", [:mix], "hexpm", "bbb"},
  "phoenix": {:hex, :phoenix, "1.7.10", "aaa", [:mix], "hexpm", "bbb"},
  "plain": {:hex, :plain, "1.0.0", "aaa", [:mix], "hexpm", "bbb"},
  "x": {:hex, :x, "1.0.5", "aaa", [:mix], "hexpm", "bbb"}
}
`;

  it('maps optional and dev sections, and leaves dev rows out of Hex lookups and drift buckets', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-elixir-mix-'));
    fs.writeFileSync(path.join(root, 'mix.exs'), MIX);
    fs.writeFileSync(path.join(root, 'mix.lock'), LOCK);
    const fetchSpy = vi.spyOn(hexCache, 'fetchHexVersionsBulk');

    const project = await scanElixir(root, undefined, MANIFEST, true);
    expect(project).not.toBeNull();
    expect(project!.dependencies.map((dep) => [dep.package, dep.section])).toEqual([
      ['phoenix', 'dependencies'],
      ['jason', 'optionalDependencies'],
      ['plain', 'dependencies'],
      ['bare', 'dependencies'],
      ['both', 'dependencies'],
      ['x', 'devDependencies'],
      ['credo', 'devDependencies'],
      ['dialyxir', 'devDependencies'],
    ]);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[0]).toEqual(['phoenix', 'jason', 'plain', 'bare', 'both']);
    expect(fetchSpy.mock.calls[0]?.[2]).toBe(true);

    const byName = new Map(project!.dependencies.map((dep) => [dep.package, dep]));
    expect(byName.get('jason')?.latestStable).toBe('1.4.4');
    expect(byName.get('jason')?.resolvedVersion).toBe('1.4.1');
    expect(byName.get('credo')?.resolvedVersion).toBe('1.7.6');
    expect(byName.get('credo')?.latestStable).toBeNull();
    expect(byName.get('credo')?.drift).toBe('unknown');
    expect(byName.get('x')?.latestStable).toBeNull();
    expect(byName.get('dialyxir')?.section).toBe('devDependencies');
    // plain, bare, and both are current. phoenix is one major behind.
    // jason is minor-behind; the existing bucket counter records that as
    // unknown because majorsBehind is 0. Dev rows are not in the total.
    expect(project!.dependencyAgeBuckets).toEqual({
      current: 3,
      oneBehind: 1,
      twoPlusBehind: 0,
      unknown: 1,
    });

    const scanArtifact = artifact([project!]);
    const graph = collectLockfileGraph(scanArtifact, root);
    const cdx = toCycloneDx(scanArtifact, graph) as {
      components: Array<{ name: string; scope?: string; properties: Array<{ name: string; value: string }> }>;
      dependencies?: unknown;
    };
    const component = new Map(cdx.components.map((row) => [row.name, row]));
    const vibScope = (name: string): string | undefined =>
      component.get(name)?.properties.find((property) => property.name === 'vibgrate:scope')?.value;

    expect(component.get('jason')?.scope).toBe('optional');
    expect(component.get('x')?.scope).toBe('excluded');
    expect(component.get('credo')?.scope).toBe('excluded');
    expect(component.get('plain')?.scope).toBeUndefined();
    expect(component.get('both')?.scope).toBeUndefined();
    expect(component.get('phoenix')?.scope).toBeUndefined();
    expect(component.has('my_git')).toBe(false);
    for (const name of ['phoenix', 'jason', 'plain', 'bare', 'both', 'x', 'credo', 'dialyxir']) {
      expect(vibScope(name)).toBe('direct');
    }
    expect(cdx.dependencies).toBeUndefined();

    const spdx = toSpdx(scanArtifact, graph) as {
      relationships: Array<{ spdxElementId: string; relatedSpdxElementId: string; relationshipType: string }>;
      packages: Array<{ name: string }>;
    };
    const id = (name: string): string => `SPDXRef-Package-${spdx.packages.findIndex((pkg) => pkg.name === name) + 1}`;
    const rel = (name: string): string | undefined =>
      spdx.relationships.find((row) => row.spdxElementId === id(name))?.relationshipType;
    expect(rel('jason')).toBe('OPTIONAL_DEPENDENCY_OF');
    expect(rel('x')).toBe('DEV_DEPENDENCY_OF');
    expect(rel('credo')).toBe('DEV_DEPENDENCY_OF');
    expect(rel('dialyxir')).toBe('DEV_DEPENDENCY_OF');
    expect(rel('phoenix')).toBeUndefined();
    expect(rel('plain')).toBeUndefined();
    expect(rel('both')).toBeUndefined();
    expect(spdx.relationships.some((row) => row.relationshipType === 'DEPENDS_ON')).toBe(false);
  });
});
