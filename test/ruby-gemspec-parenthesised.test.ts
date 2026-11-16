/**
 * A .gemspec can call `add_dependency` in either of two valid Ruby styles:
 *
 *   spec.add_dependency "rails", "~> 7.1"      # no parentheses
 *   spec.add_dependency("rails", "~> 7.1")     # parentheses
 *
 * The parenthesised form is common in generated and RuboCop-formatted
 * gemspecs. Both forms must produce the same dependency rows, with every
 * quoted version bound kept and drift still computed from the lower bound.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PackageVersionManifest } from '../src/core-open/package-version-manifest.js';
import { scanRubyProjects } from '../src/core-open/scanners/ruby-scanner.js';
import { RubyGemsCache } from '../src/core-open/scanners/rubygems-cache.js';
import { Semaphore } from '../src/core-open/utils/semaphore.js';
import type { DependencyRow } from '../src/core-open/types.js';

const MANIFEST: PackageVersionManifest = {
  rubygems: {
    rails: { latest: '8.0.0', versions: ['7.0.0', '7.1.0', '8.0.0'] },
    pg: { latest: '1.5.0', versions: ['1.4.0', '1.5.0'] },
    puma: { latest: '6.5.0', versions: ['6.0.0', '6.5.0'] },
    rack: { latest: '3.1.0', versions: ['2.2.0', '3.0.0', '3.1.0'] },
    'rspec-rails': { latest: '7.1.0', versions: ['6.1.0', '7.0.0', '7.1.0'] },
  },
};

const GEMSPEC_PARENTHESISED = `
Gem::Specification.new do |spec|
  spec.name = "my-gem"
  spec.add_dependency("rack", ">= 2.2", "< 4")
  spec.add_dependency('rails', '~> 7.1')
  spec.add_development_dependency("rspec-rails", ">= 6.1", "< 8")
  spec.add_runtime_dependency("puma")
  spec.add_runtime_dependency( "pg" , "~> 1.5" )
end
`;

describe('Ruby gemspec dependencies written with parentheses', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
    roots.length = 0;
  });

  async function scan(files: Record<string, string>): Promise<DependencyRow[]> {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-ruby-gemspec-parens-'));
    roots.push(root);
    for (const [name, body] of Object.entries(files)) {
      fs.writeFileSync(path.join(root, name), body);
    }
    const projects = await scanRubyProjects(root, new RubyGemsCache(new Semaphore(1), MANIFEST, true));
    expect(projects).toHaveLength(1);
    return projects[0]!.dependencies;
  }

  function dep(rows: DependencyRow[], name: string): DependencyRow {
    const found = rows.find((row) => row.package === name);
    expect(found, `${name} should not be dropped`).toBeDefined();
    return found!;
  }

  it('keeps every parenthesised gemspec dependency row', async () => {
    const rows = await scan({ 'my-gem.gemspec': GEMSPEC_PARENTHESISED });

    expect(rows.map((row) => row.package).sort()).toEqual(
      ['pg', 'puma', 'rack', 'rails', 'rspec-rails'].sort(),
    );
  });

  it('keeps every quoted bound and drifts from the lower bound', async () => {
    const rows = await scan({ 'my-gem.gemspec': GEMSPEC_PARENTHESISED });

    const rack = dep(rows, 'rack');
    expect(rack.currentSpec).toBe('>= 2.2, < 4');
    expect(rack.resolvedVersion).toBe('2.2.0');
    expect(rack.drift).toBe('major-behind');
    expect(rack.majorsBehind).toBe(1);
    expect(rack.section).toBe('dependencies');

    const rails = dep(rows, 'rails');
    expect(rails.currentSpec).toBe('~> 7.1');
    expect(rails.resolvedVersion).toBe('7.1.0');
    expect(rails.drift).toBe('major-behind');

    const pg = dep(rows, 'pg');
    expect(pg.currentSpec).toBe('~> 1.5');
    expect(pg.resolvedVersion).toBe('1.5.0');
    expect(pg.drift).toBe('current');
  });

  it('classifies a parenthesised development dependency as devDependencies', async () => {
    const rows = await scan({ 'my-gem.gemspec': GEMSPEC_PARENTHESISED });

    const rspec = dep(rows, 'rspec-rails');
    expect(rspec.currentSpec).toBe('>= 6.1, < 8');
    expect(rspec.section).toBe('devDependencies');
  });

  it('still reads the parenthesised call that declares no version', async () => {
    const rows = await scan({ 'my-gem.gemspec': GEMSPEC_PARENTHESISED });

    const puma = dep(rows, 'puma');
    expect(puma.resolvedVersion).toBeNull();
    expect(puma.drift).toBe('unknown');
  });
});
