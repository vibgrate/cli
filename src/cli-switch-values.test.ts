import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command, CommanderError } from 'commander';
import { describe, expect, it } from 'vitest';
import { buildProgram } from './cli.js';
import { switchValueError } from './cli-switch-values.js';

/**
 * CI templates often spell switches out explicitly (`--vulns=false`,
 * `--no-vulns`), usually from a templated variable. `vg` must never read such
 * an input as "on", and when it rejects one the error must name the switch and
 * show a form that works.
 */

const SWITCHES = ['--vulns', '--offline'] as const;
const attr = (flag: string): string => flag.slice(2);

class Parsed extends Error {
  constructor(readonly opts: Record<string, unknown>) {
    super('parsed');
  }
}

/**
 * Parse `vg scan <dir> ...args` through the real program and return the
 * options commander resolved, or the error it rejected the input with. The
 * scan itself never runs.
 */
async function parseScan(args: string[]): Promise<Record<string, unknown> | CommanderError> {
  const scan = buildProgram().commands.find((c) => c.name() === 'scan') as Command;
  scan.exitOverride();
  scan.configureOutput({ writeErr: () => {}, writeOut: () => {} });
  scan.hook('preAction', (_cmd, action) => {
    throw new Parsed(action.opts());
  });
  try {
    await scan.parseAsync([os.tmpdir(), ...args], { from: 'user' });
  } catch (e) {
    if (e instanceof Parsed) return e.opts;
    if (e instanceof CommanderError) return e;
    throw e;
  }
  throw new Error('scan did not reach its action');
}

describe('vg scan switches parse as documented', () => {
  for (const flag of SWITCHES) {
    describe(flag, () => {
      it('is off when absent', async () => {
        const opts = await parseScan([]);
        expect(opts).not.toBeInstanceOf(CommanderError);
        expect((opts as Record<string, unknown>)[attr(flag)]).toBeUndefined();
      });

      it(`is on with ${flag}`, async () => {
        const opts = await parseScan([flag]);
        expect((opts as Record<string, unknown>)[attr(flag)]).toBe(true);
      });

      for (const input of [`${flag}=true`, `${flag}=false`, `${flag}=maybe`, `${flag}=`, `--no-${attr(flag)}`]) {
        it(`rejects ${input} and never turns the switch on`, async () => {
          const res = await parseScan([input]);
          expect(res).toBeInstanceOf(CommanderError);
          expect((res as CommanderError).code).toBe('commander.unknownOption');
        });
      }
    });
  }
});

describe('switchValueError', () => {
  const program = buildProgram();

  for (const flag of SWITCHES) {
    for (const value of ['true', 'false', 'maybe', '']) {
      it(`explains ${flag}=${value} with the switch and a working example`, () => {
        const msg = switchValueError(program, ['scan', '.', `${flag}=${value}`]);
        expect(msg).toContain(`${flag} is an on/off switch and takes no value`);
        expect(msg).toContain(`got ${flag}=${value}`);
        expect(msg).toContain(`vg scan ${flag}`);
      });
    }

    it(`explains --no-${attr(flag)} without suggesting the opposite`, () => {
      const msg = switchValueError(program, ['scan', `--no-${attr(flag)}`, '.']);
      expect(msg).toContain(`--no-${attr(flag)} is not an option`);
      expect(msg).toContain(`${flag} is off unless you pass it`);
      expect(msg).toContain(`vg scan ${flag}`);
    });
  }

  it('explains a value on a --no- switch the command does define', () => {
    expect(switchValueError(program, ['scan', '--no-graph=1'])).toContain(
      '--no-graph is an on/off switch and takes no value (got --no-graph=1)',
    );
  });

  it.each([
    [['scan', '.', '--vulns', '--offline']],
    [['scan', '.', '--format=json']],
    [['scan', '.', '--bogus=1']],
    [['scan', '.', '--no-graph']],
    [['scan', '.', '--', '--vulns=false']],
    [['scan', '.', '--no-such-switch']],
  ])('leaves valid or unrelated input to commander: %j', (args) => {
    expect(switchValueError(program, args)).toBeUndefined();
  });

  it('does not inspect arguments a pass-through command forwards', () => {
    // `vg serve <agent> ...` hands everything after the agent name to the agent.
    // `--http` is a serve switch, so without the pass-through rule this would match.
    expect(switchValueError(program, ['serve', 'claude', '--http=1'])).toBeUndefined();
  });
});

describe('vg scan with a switch value, end to end', () => {
  const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-switch-'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"fixture","version":"1.0.0"}\n');

  const run = (flag: string) =>
    spawnSync(
      process.execPath,
      ['--import', 'tsx', path.join(pkgRoot, 'src/cli.ts'), 'scan', dir, '--offline', '--no-graph', '--no-daemon', '--quiet', '--no-local-artifacts', flag],
      { cwd: pkgRoot, encoding: 'utf8', timeout: 45_000, env: { ...process.env, NO_COLOR: '1', VIBGRATE_NO_KERNEL: '1', VIBGRATE_DSN: '' } },
    );

  it.each(['--vulns=false', '--no-vulns'])('%s exits with the usage code and a working example', (flag) => {
    const res = run(flag);
    expect(res.status).toBe(5);
    expect(res.stderr).toContain('vg scan --vulns');
    expect(res.stderr).not.toContain('Did you mean');
  }, 60_000);
});
