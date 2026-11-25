/**
 * An Elixir project that pins its toolchain in `.tool-versions` still reports
 * a runtime when mix.exs has no `elixir:` requirement. An explicit mix.exs
 * requirement stays the winner.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/core-open/scanners/hex-cache.js', () => ({
  fetchHexVersionsBulk: vi.fn(async () => new Map<string, string>()),
}));

import {
  elixirVersionFromToolVersions,
  scanElixir,
} from '../src/core-open/scanners/elixir-scanner.js';
import { FileCache } from '../src/core-open/utils/fs.js';

function mixExs(elixirLine?: string): string {
  const line = elixirLine ? `      ${elixirLine}\n` : '';
  return `defmodule Sample.MixProject do
  use Mix.Project

  def project do
    [
      app: :sample,
      version: "0.1.0",
${line}      deps: []
    ]
  end
end
`;
}

describe('Elixir runtime pin files', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
    roots.length = 0;
  });

  function makeRoot(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-elixir-pin-'));
    roots.push(root);
    return root;
  }

  async function scan(files: Record<string, string>, cache?: FileCache) {
    const root = makeRoot();
    for (const [name, body] of Object.entries(files)) {
      fs.writeFileSync(path.join(root, name), body);
    }
    const project = await scanElixir(root, cache, undefined, true);
    expect(project).not.toBeNull();
    return project!;
  }

  it('reads an elixir requirement from mix.exs', async () => {
    const project = await scan({ 'mix.exs': mixExs('elixir: "~> 1.15",') });
    expect(project.runtime).toBe('~> 1.15');
  });

  it('falls back to .tool-versions when mix.exs has no elixir requirement', async () => {
    const project = await scan({
      'mix.exs': mixExs(),
      '.tool-versions': 'erlang 26.2.5\nelixir 1.16.3-otp-26\n',
    });
    expect(project.runtime).toBe('1.16.3');
  });

  it('keeps the mix.exs requirement ahead of .tool-versions', async () => {
    const project = await scan({
      'mix.exs': mixExs('elixir: "~> 1.15",'),
      '.tool-versions': 'elixir 1.16.3\n',
    });
    expect(project.runtime).toBe('~> 1.15');
  });

  it('reads .tool-versions through the scan cache', async () => {
    const project = await scan({
      'mix.exs': mixExs(),
      '.tool-versions': 'elixir 1.16.3\n',
    }, new FileCache());
    expect(project.runtime).toBe('1.16.3');
  });

  it('takes the first elixir version token and ignores comments and blank lines', () => {
    expect(elixirVersionFromToolVersions([
      '# toolchains',
      '',
      'erlang 26.2.5',
      'elixir 1.16.3 # pinned for prod',
      'elixir 1.15.8',
      '',
    ].join('\n'))).toBe('1.16.3');
  });

  it('strips the asdf OTP suffix', () => {
    expect(elixirVersionFromToolVersions('elixir 1.16.3-otp-26\n')).toBe('1.16.3');
  });

  it('skips non-version tokens such as system, ref:, and path:', () => {
    expect(elixirVersionFromToolVersions('elixir system\n')).toBeUndefined();
    expect(elixirVersionFromToolVersions('elixir ref:abc123\n')).toBeUndefined();
    expect(elixirVersionFromToolVersions('elixir path:../elixir\n')).toBeUndefined();
    expect(elixirVersionFromToolVersions('erlang 26.2.5\n')).toBeUndefined();
    expect(elixirVersionFromToolVersions('elixir system\nelixir 1.16.3\n')).toBe('1.16.3');
  });
});
