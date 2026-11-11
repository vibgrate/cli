/**
 * Bundler 2.4+ `ruby file: ".ruby-version"` and projects that pin Ruby
 * only in `.ruby-version` or `.tool-versions` still report a runtime.
 * An explicit `ruby '3.1.0'` line stays ahead of those files.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { latestStable } from '../src/core-open/runtimes/catalog.js';
import { BUNDLED_RUNTIME_CATALOG } from '../src/core-open/runtimes/snapshot.js';
import {
  rubyVersionFromRubyVersionFile,
  rubyVersionFromToolVersions,
  scanRubyProjects,
} from '../src/core-open/scanners/ruby-scanner.js';
import { RubyGemsCache } from '../src/core-open/scanners/rubygems-cache.js';
import type { ProjectScan } from '../src/core-open/types.js';
import { FileCache } from '../src/core-open/utils/fs.js';
import { Semaphore } from '../src/core-open/utils/semaphore.js';

function rubyLag(version: string): { latest: string; behind: number } {
  const match = /(\d+)\.(\d+)/.exec(version);
  if (!match) throw new Error(`no ruby version in ${version}`);
  const reqMajor = Number(match[1]);
  const reqMinor = Number(match[2]);
  const latest = latestStable(BUNDLED_RUNTIME_CATALOG, 'ruby');
  if (!latest) throw new Error('ruby catalog has no released cycle');
  const behind = reqMajor === latest.major
    ? Math.max(0, latest.minor - reqMinor)
    : latest.minor + (latest.major - reqMajor) * 10;
  return { latest: `${latest.major}.${latest.minor}`, behind };
}

describe('Ruby runtime pin files', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
    roots.length = 0;
  });

  function makeRoot(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-ruby-pin-'));
    roots.push(root);
    return root;
  }

  function write(root: string, name: string, body: string): void {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  }

  async function scan(root: string, cache?: FileCache): Promise<ProjectScan[]> {
    return scanRubyProjects(root, new RubyGemsCache(new Semaphore(1), undefined, true), cache);
  }

  it('strips a ruby- prefix and whitespace, and skips non-version tokens', () => {
    expect(rubyVersionFromRubyVersionFile('  ruby-3.2.2  \r\n')).toBe('3.2.2');
    expect(rubyVersionFromRubyVersionFile('\n# local pin\r\n3.3.4\r\n')).toBe('3.3.4');
    expect(rubyVersionFromRubyVersionFile('\uFEFF3.3.4\n')).toBe('3.3.4');
    expect(rubyVersionFromRubyVersionFile('system\n3.3.4\n')).toBeUndefined();
    expect(rubyVersionFromToolVersions('nodejs 22.11.0\nruby ruby-3.4.1 3.3.0\n')).toBe('3.4.1');
    expect(rubyVersionFromToolVersions('# ruby 2.6.10\nruby 3.2.2 # app\n')).toBe('3.2.2');
    expect(rubyVersionFromToolVersions('ruby system\nruby 3.1.4\n')).toBe('3.1.4');
    expect(rubyVersionFromToolVersions('ruby system\n')).toBeUndefined();
  });

  for (const cached of [false, true]) {
    describe(cached ? 'with FileCache' : 'without FileCache', () => {
      function cache(): FileCache | undefined {
        return cached ? new FileCache() : undefined;
      }

      it('reads ruby file: ".ruby-version" as runtime 3.3.4', async () => {
        const root = makeRoot();
        write(root, 'Gemfile', [
          "source 'https://rubygems.org'",
          'ruby file: ".ruby-version"',
          "gem 'rails', '~> 7.1'",
          '',
        ].join('\n'));
        write(root, '.ruby-version', '3.3.4\n');

        const projects = await scan(root, cache());
        expect(projects).toHaveLength(1);
        const project = projects[0]!;
        expect(project.runtime).toBe('3.3.4');
        const lag = rubyLag('3.3.4');
        expect(project.runtimeLatest).toBe(lag.latest);
        expect(project.runtimeMajorsBehind).toBe(lag.behind);
      });

      it('reads single quotes, the hash rocket, and a path next to the Gemfile', async () => {
        const root = makeRoot();
        write(root, 'quotes/Gemfile', "ruby file: '.ruby-version'\n");
        write(root, 'quotes/.ruby-version', '  ruby-3.3.4 \n');
        write(root, 'rocket/Gemfile', 'ruby :file => ".ruby-version"\n');
        write(root, 'rocket/.ruby-version', '3.3.4\n');
        write(root, 'nested/Gemfile', 'ruby file: "config/.ruby-version"\n');
        write(root, 'nested/config/.ruby-version', '3.3.4\n');
        write(root, '.ruby-version', '2.6.10\n');

        const projects = await scan(root, cache());
        const byPath = new Map(projects.map((project) => [project.path, project.runtime]));
        expect(byPath.get('quotes')).toBe('3.3.4');
        expect(byPath.get('rocket')).toBe('3.3.4');
        expect(byPath.get('nested')).toBe('3.3.4');
      });

      it('falls back to .ruby-version ruby-3.2.2 when the Gemfile has no ruby line', async () => {
        const root = makeRoot();
        write(root, 'Gemfile', "source 'https://rubygems.org'\ngem 'rails'\n");
        write(root, '.ruby-version', 'ruby-3.2.2\n');
        write(root, '.tool-versions', 'ruby 3.4.1\n');

        const projects = await scan(root, cache());
        expect(projects).toHaveLength(1);
        const project = projects[0]!;
        expect(project.runtime).toBe('3.2.2');
        const lag = rubyLag('3.2.2');
        expect(project.runtimeLatest).toBe(lag.latest);
        expect(project.runtimeMajorsBehind).toBe(lag.behind);
      });

      it('uses a ruby entry in .tool-versions when .ruby-version is absent or not a version', async () => {
        const root = makeRoot();
        write(root, 'missing/Gemfile', "gem 'rails'\n");
        write(root, 'missing/.tool-versions', 'nodejs 22.11.0\nruby ruby-3.4.1\n');
        write(root, 'system/Gemfile', "gem 'rails'\n");
        write(root, 'system/.ruby-version', 'system\n');
        write(root, 'system/.tool-versions', 'ruby 3.2.2\n');

        const projects = await scan(root, cache());
        const byPath = new Map(projects.map((project) => [project.path, project.runtime]));
        expect(byPath.get('missing')).toBe('3.4.1');
        expect(byPath.get('system')).toBe('3.2.2');
      });

      it('keeps an explicit ruby line ahead of pin files', async () => {
        const root = makeRoot();
        write(root, 'Gemfile', [
          "source 'https://rubygems.org'",
          "ruby '3.1.0'",
          "gem 'rails'",
          '',
        ].join('\n'));
        write(root, '.ruby-version', 'ruby-3.2.2\n');
        write(root, '.tool-versions', 'ruby 3.3.4\n');

        const projects = await scan(root, cache());
        expect(projects).toHaveLength(1);
        const project = projects[0]!;
        expect(project.runtime).toBe('3.1.0');
        const lag = rubyLag('3.1.0');
        expect(project.runtimeLatest).toBe(lag.latest);
        expect(project.runtimeMajorsBehind).toBe(lag.behind);
      });

      it('does not throw when the ruby file: target is missing', async () => {
        const root = makeRoot();
        write(root, 'Gemfile', 'ruby file: "missing-version"\n');
        write(root, '.ruby-version', '3.2.2\n');
        write(root, '.tool-versions', 'ruby 3.3.4\n');

        const projects = await scan(root, cache());
        expect(projects).toHaveLength(1);
        expect(projects[0]!.runtime).toBeUndefined();
        expect(projects[0]!.runtimeMajorsBehind).toBeUndefined();
      });
    });
  }
});
