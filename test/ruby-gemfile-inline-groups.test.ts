/**
 * Bundler accepts `group:` and `groups:` on a gem line. `groups:` is a
 * dev dependency only when every listed symbol is :development, :dev, or
 * :test. `group:` keeps its existing substring check.
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

gem 'group_dev', '~> 1.0', group: :development
gem 'group_test', group: :test
gem 'group_dev_alias', group: :dev
gem 'group_array_dev', group: [:development, :test]
gem 'group_mixed', group: [:development, :production]
gem 'group_prod', group: :production

gem 'groups_test', groups: :test
gem 'groups_dev', groups: :development
gem 'groups_dev_alias', groups: :dev
gem "groups_quoted", groups: [:test]
gem 'groups_array_dev', '~> 3.12', groups: [:development, :test], require: false
gem 'groups_array_order', groups: [:test, :development]
gem 'groups_mixed', groups: [:development, :production]
gem 'groups_mixed_order', groups: [:production, :development]
gem 'groups_default_test', groups: [:default, :test]
gem 'groups_prod', groups: :production

group :development do
  gem 'block_dev', '~> 2.0'
  gem 'block_groups_mixed', groups: [:development, :production]
  gem 'block_group_prod', group: :production
  gem 'block_groups_test', groups: :test
end

gem 'after_block', '~> 1.0'
`;

const DEV = 'devDependencies';
const PROD = 'dependencies';

const SECTIONS: Record<string, typeof DEV | typeof PROD> = {
  rails: PROD,
  group_dev: DEV,
  group_test: DEV,
  group_dev_alias: DEV,
  group_array_dev: DEV,
  group_mixed: DEV,
  group_prod: PROD,
  groups_test: DEV,
  groups_dev: DEV,
  groups_dev_alias: DEV,
  groups_quoted: DEV,
  groups_array_dev: DEV,
  groups_array_order: DEV,
  groups_mixed: PROD,
  groups_mixed_order: PROD,
  groups_default_test: PROD,
  groups_prod: PROD,
  block_dev: DEV,
  block_groups_mixed: PROD,
  block_group_prod: DEV,
  block_groups_test: DEV,
  after_block: PROD,
};

describe('Gemfile inline group and groups', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
    roots.length = 0;
  });

  async function scan(gemfile: string) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-gemfile-inline-groups-'));
    roots.push(root);
    fs.writeFileSync(path.join(root, 'Gemfile'), gemfile);
    const projects = await scanRubyProjects(root, new RubyGemsCache(new Semaphore(1), undefined, true));
    expect(projects).toHaveLength(1);
    return projects[0]!;
  }

  it('records groups: as dev only when every symbol is development, dev, or test', async () => {
    const project = await scan(GEMFILE);
    const sections = new Map(project.dependencies.map((dep) => [dep.package, dep.section]));
    expect(sections.size).toBe(Object.keys(SECTIONS).length);
    for (const [name, section] of Object.entries(SECTIONS)) {
      expect(sections.get(name), name).toBe(section);
    }
    expect(project.dependencies.find((dep) => dep.package === 'groups_array_dev')?.currentSpec).toBe('~> 3.12');
    expect(project.dependencies.find((dep) => dep.package === 'group_dev')?.currentSpec).toBe('~> 1.0');
  });
});
