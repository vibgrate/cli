import { describe, it, expect, afterEach } from 'vitest';
import { Command } from 'commander';
import { buildGraph } from '../src/engine/build.js';
import { writeArtifacts } from '../src/engine/artifacts.js';
import { registerTree } from '../src/commands/tree.js';
import { registerPath } from '../src/commands/path.js';
import { makeProject, cleanup } from './helpers.js';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) cleanup(dirs.pop()!);
});

// Two files each defining `foo` → an ambiguous short name to disambiguate.
const FILES = {
  'a/x.ts': 'export function foo() { return 1; }',
  'b/x.ts': 'export function foo() { return 2; }',
};

async function project(): Promise<string> {
  const dir = makeProject(FILES);
  dirs.push(dir);
  const { graph } = await buildGraph({ root: dir, generatedAt: '2020-01-01T00:00:00.000Z', inline: true });
  writeArtifacts(graph, { root: dir });
  return dir;
}

function run(register: (p: Command) => void, argv: string[]): Promise<unknown> {
  const program = new Command();
  program.exitOverride();
  register(program);
  return program.parseAsync(argv, { from: 'user' });
}

describe('tree --pick disambiguation', () => {
  it('errors on an ambiguous name without --pick', async () => {
    const dir = await project();
    await expect(run(registerTree, ['tree', 'foo', '-C', dir])).rejects.toThrow(/ambiguous/);
  });

  it('resolves an ambiguous name with --pick', async () => {
    const dir = await project();
    await expect(run(registerTree, ['tree', 'foo', '--pick', '1', '-C', dir])).resolves.toBeDefined();
  });
});

describe('path --pick-a / --pick-b disambiguation', () => {
  it('errors with the --pick-a hint when A is ambiguous', async () => {
    const dir = await project();
    await expect(run(registerPath, ['path', 'foo', 'foo', '-C', dir])).rejects.toThrow(/--pick-a/);
  });

  it('resolves both endpoints with --pick-a/--pick-b (then reports no path)', async () => {
    const dir = await project();
    // The two `foo`s are unconnected, so getting to the "no path" error proves
    // both endpoints resolved past the ambiguity guard.
    await expect(
      run(registerPath, ['path', 'foo', 'foo', '--pick-a', '1', '--pick-b', '2', '-C', dir]),
    ).rejects.toThrow(/no path/);
  });
});
