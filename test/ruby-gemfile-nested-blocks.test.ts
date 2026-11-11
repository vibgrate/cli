/**
 * A nested `do` / `if` / `unless` inside a Gemfile `group` must not close
 * the group. Gems after the inner `end` stay in that group. A top-level
 * `platforms` or `install_if ... do` block stays production.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scanRubyProjects } from '../src/core-open/scanners/ruby-scanner.js';
import { RubyGemsCache } from '../src/core-open/scanners/rubygems-cache.js';
import { Semaphore } from '../src/core-open/utils/semaphore.js';

const GEMFILE = `
source 'https://rubygems.org'

gem 'rails', '~> 7.1'

platforms :jruby do
  gem 'jruby-openssl', '~> 0.14'
end

install_if -> { RUBY_PLATFORM =~ /darwin/ } do
  gem 'terminal-notifier', '~> 2.0'
end

group :development do
  platforms :mri do
    gem 'byebug', '~> 11.1'
  end
  gem 'listen', '~> 3.0'
  install_if -> { RUBY_PLATFORM =~ /darwin/ } do
    gem 'rb-fsevent', '~> 0.11'
  end
  if ENV['DEBUG']
    gem 'pry', '~> 0.14'
  end
  unless ENV['CI']
    gem 'spring', '~> 4.0'
  end
  gem 'wdm', '>= 0.1.0' if Gem.win_platform?
end

gem 'puma', '~> 6.0'
`;

const DEV = 'devDependencies';
const PROD = 'dependencies';

const SECTIONS: Record<string, typeof DEV | typeof PROD> = {
  rails: PROD,
  'jruby-openssl': PROD,
  'terminal-notifier': PROD,
  byebug: DEV,
  listen: DEV,
  'rb-fsevent': DEV,
  pry: DEV,
  spring: DEV,
  wdm: DEV,
  puma: PROD,
};

describe('Gemfile nested blocks inside a group', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
    roots.length = 0;
  });

  async function scan(gemfile: string) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-gemfile-nested-blocks-'));
    roots.push(root);
    fs.writeFileSync(path.join(root, 'Gemfile'), gemfile);
    const projects = await scanRubyProjects(root, new RubyGemsCache(new Semaphore(1), undefined, true));
    expect(projects).toHaveLength(1);
    return projects[0]!;
  }

  it('keeps gems after an inner platforms, install_if, if, or unless in the group', async () => {
    const project = await scan(GEMFILE);
    const sections = new Map(project.dependencies.map((dep) => [dep.package, dep.section]));
    expect(sections.size).toBe(Object.keys(SECTIONS).length);
    for (const [name, section] of Object.entries(SECTIONS)) {
      expect(sections.get(name), name).toBe(section);
    }
    expect(project.dependencies.find((dep) => dep.package === 'byebug')?.currentSpec).toBe('~> 11.1');
    expect(project.dependencies.find((dep) => dep.package === 'listen')?.currentSpec).toBe('~> 3.0');
  });
});
