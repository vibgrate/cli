/**
 * A gem or gemspec dependency can declare several quoted version bounds
 * before a keyword (`require:`, `group:`, `platforms:`). Every bound is
 * kept, joined with ", ". Drift still uses the first (lower) bound, so a
 * single-constraint line resolves the same version it did before.
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

const GEMFILE = `
source 'https://rubygems.org'

gem "rails", ">= 7.0", "< 8"
gem "pg", "~> 1.5", require: false
gem 'puma', '~> 6.0'
gem 'sidekiq', '~> 7.3' # "< 9"
gem 'devise', '>= 4.8', platforms: :ruby, '< 5'
gem 'rspec-rails', group: :test, '~> 7.0'
`;

const GEMSPEC = `
Gem::Specification.new do |spec|
  spec.name = "my-gem"
  spec.add_dependency "rack", ">= 2.2", "< 4"
  spec.add_dependency 'rails', '~> 7.1'
  spec.add_development_dependency "rspec-rails", ">= 6.1", "< 8", require: false
end
`;

describe('Ruby version constraints', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
    roots.length = 0;
  });

  async function scan(files: Record<string, string>): Promise<DependencyRow[]> {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-ruby-constraints-'));
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
    expect(found, name).toBeDefined();
    return found!;
  }

  it('joins every quoted Gemfile constraint and still drifts from the lower bound', async () => {
    const rows = await scan({ Gemfile: GEMFILE });

    const rails = dep(rows, 'rails');
    expect(rails.currentSpec).toBe('>= 7.0, < 8');
    expect(rails.resolvedVersion).toBe('7.0.0');
    expect(rails.drift).toBe('major-behind');
    expect(rails.majorsBehind).toBe(1);

    const pg = dep(rows, 'pg');
    expect(pg.currentSpec).toBe('~> 1.5');
    expect(pg.resolvedVersion).toBe('1.5.0');
    expect(pg.drift).toBe('current');
    expect(pg.majorsBehind).toBe(0);
    expect(pg.section).toBe('dependencies');

    const puma = dep(rows, 'puma');
    expect(puma.currentSpec).toBe('~> 6.0');
    expect(puma.resolvedVersion).toBe('6.0.0');
    expect(puma.drift).toBe('minor-behind');
    expect(puma.majorsBehind).toBe(0);

    expect(dep(rows, 'sidekiq').currentSpec).toBe('~> 7.3');
    expect(dep(rows, 'devise').currentSpec).toBe('>= 4.8');
    expect(dep(rows, 'rspec-rails').currentSpec).toBe('*');
    expect(dep(rows, 'rspec-rails').section).toBe('devDependencies');
    expect(dep(rows, 'rspec-rails').drift).toBe('unknown');
  });

  it('joins every quoted gemspec constraint and still drifts from the lower bound', async () => {
    const rows = await scan({ 'my-gem.gemspec': GEMSPEC });

    const rack = dep(rows, 'rack');
    expect(rack.currentSpec).toBe('>= 2.2, < 4');
    expect(rack.resolvedVersion).toBe('2.2.0');
    expect(rack.drift).toBe('major-behind');
    expect(rack.majorsBehind).toBe(1);

    const rails = dep(rows, 'rails');
    expect(rails.currentSpec).toBe('~> 7.1');
    expect(rails.resolvedVersion).toBe('7.1.0');
    expect(rails.drift).toBe('major-behind');
    expect(rails.majorsBehind).toBe(1);

    const rspec = dep(rows, 'rspec-rails');
    expect(rspec.currentSpec).toBe('>= 6.1, < 8');
    expect(rspec.resolvedVersion).toBe('6.1.0');
    expect(rspec.section).toBe('devDependencies');
    expect(rspec.drift).toBe('major-behind');
    expect(rspec.majorsBehind).toBe(1);
  });
});
