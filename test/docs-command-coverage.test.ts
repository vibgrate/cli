/**
 * The public docs are part of the CLI's surface: a command that ships without
 * a line in README.md and a section in DOCS.md is a command nobody can find.
 * This gate fails the moment a new verb is registered without documenting it.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KNOWN_COMMANDS, buildProgram } from '../src/cli.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf-8');
const docs = fs.readFileSync(path.join(root, 'DOCS.md'), 'utf-8');

/**
 * Verbs with no documentation of their own, by design:
 *   help      — commander's built-in
 *   hook      — hidden; an assistant-host endpoint wired by `vg install --hooks`
 * `uninstall` is documented alongside `install`, and the map views alongside `map`.
 */
const UNDOCUMENTED_BY_DESIGN = new Set(['help', 'hook']);
const DOCUMENTED_WITH = new Map([
  ['uninstall', 'install'],
  ['hubs', 'map'],
  ['areas', 'map'],
  ['oddities', 'map'],
]);

const documentedName = (cmd: string): string => DOCUMENTED_WITH.get(cmd) ?? cmd;

const commands = [...KNOWN_COMMANDS].filter((c) => !UNDOCUMENTED_BY_DESIGN.has(c)).sort();

describe('public docs cover the command surface', () => {
  it.each(commands)('README.md mentions `vg %s`', (cmd) => {
    expect(readme).toContain(`vg ${documentedName(cmd)}`);
  });

  it.each(commands)('DOCS.md mentions `vg %s`', (cmd) => {
    expect(docs).toContain(`vg ${documentedName(cmd)}`);
  });

  it('every registered subcommand is in KNOWN_COMMANDS', () => {
    const registered = buildProgram()
      .commands.map((c) => c.name())
      .filter((n) => n !== 'help');
    for (const name of registered) expect([...KNOWN_COMMANDS]).toContain(name);
  });

  it('DOCS.md documents every exit code the CLI can return', async () => {
    const { ExitCode } = await import('../src/util/exit.js');
    const table = docs.slice(docs.indexOf('## Exit Codes'));
    for (const [name, code] of Object.entries(ExitCode)) {
      expect(table, `exit code ${code} (${name})`).toContain(`\`${code}\``);
      expect(table, `exit code name ${name}`).toContain(name);
    }
  });
});
