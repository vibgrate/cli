/**
 * A Gemfile `group ... do` block is development/test only when every symbol
 * on that line is `:development`, `:dev`, or `:test`. A production or default
 * group beside those keeps the gems in dependencies. Inline `group:` is
 * unchanged.
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

group :development do
  gem 'listen', '~> 3.0'
end

group :test do
  gem 'rspec', '~> 3.12'
end

group :dev do
  gem 'dotenv', '~> 2.8'
end

group :production do
  gem 'puma', '~> 6.0'
end

group :development, :test do
  gem 'debug', '~> 1.0'
end

group :development, :production do
  gem 'bootsnap', '~> 1.16'
end

group :default, :test do
  gem 'rack', '~> 3.0'
end

group :production, :development do
  gem 'sidekiq', '~> 7.0'
end

group :test, :dev do
  gem 'minitest', '~> 5.0'
end

group [:development, :test] do
  gem 'factory_bot', '~> 6.0'
end

group [:development, :production] do
  gem 'redis', '~> 5.0'
end

group [:default, :test] do
  gem 'connection_pool', '~> 2.4'
end

group [:production, :development] do
  gem 'faraday', '~> 2.0'
end

group [:development] do
  gem 'rubocop', '~> 1.50'
end

group [:test] do
  gem 'capybara', '~> 3.0'
end

group [:dev] do
  gem 'pry', '~> 0.14'
end

group [:production] do
  gem 'unicorn', '~> 6.0'
end

gem 'after_groups', '~> 1.0'

gem 'inline_dev', group: :development
gem 'inline_test', group: :test
gem 'inline_prod', group: :production
gem 'inline_mixed', group: [:development, :production]
gem 'inline_array_dev', group: [:development, :test]
`;

const DEV = 'devDependencies';
const PROD = 'dependencies';

const SECTIONS: Record<string, typeof DEV | typeof PROD> = {
  rails: PROD,
  listen: DEV,
  rspec: DEV,
  dotenv: DEV,
  puma: PROD,
  debug: DEV,
  bootsnap: PROD,
  rack: PROD,
  sidekiq: PROD,
  minitest: DEV,
  factory_bot: DEV,
  redis: PROD,
  connection_pool: PROD,
  faraday: PROD,
  rubocop: DEV,
  capybara: DEV,
  pry: DEV,
  unicorn: PROD,
  after_groups: PROD,
  inline_dev: DEV,
  inline_test: DEV,
  inline_prod: PROD,
  inline_mixed: DEV,
  inline_array_dev: DEV,
};

describe('Gemfile group blocks', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
    roots.length = 0;
  });

  async function sectionsFor(gemfile: string): Promise<Map<string, string>> {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-gemfile-groups-'));
    roots.push(root);
    fs.writeFileSync(path.join(root, 'Gemfile'), gemfile);
    const projects = await scanRubyProjects(root, new RubyGemsCache(new Semaphore(1), undefined, true));
    expect(projects).toHaveLength(1);
    return new Map(projects[0]!.dependencies.map((dep) => [dep.package, dep.section]));
  }

  it('treats a block as dev only when every group is development, dev, or test', async () => {
    const sections = await sectionsFor(GEMFILE);
    expect(sections.size).toBe(Object.keys(SECTIONS).length);
    for (const [name, section] of Object.entries(SECTIONS)) {
      expect(sections.get(name), name).toBe(section);
    }
  });
});
