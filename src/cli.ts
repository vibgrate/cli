#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Command, CommanderError } from 'commander';
import { VERSION } from './version.js';
import { resolveCliInvocation, NPX_INVOCATION } from './util/cli-invocation.js';
import { registerBuild, runBuild } from './commands/build.js';
import { registerStatus } from './commands/status.js';
import { registerAsk } from './commands/ask.js';
import { registerEmbed } from './commands/embed.js';
import { registerShow } from './commands/show.js';
import { registerPath } from './commands/path.js';
import { registerTree } from './commands/tree.js';
import { registerInsights } from './commands/insights.js';
import { registerImpact } from './commands/impact.js';
import { registerUnknowns } from './commands/unknowns.js';
import { registerServe } from './commands/serve.js';
import { registerLsp } from './commands/lsp.js';
import { registerInstall } from './commands/install.js';
import { registerShare } from './commands/share.js';
import { registerBenchmark } from './commands/benchmark.js';
import { registerTests } from './commands/tests.js';
import { registerFacts } from './commands/facts.js';
import { registerGuide } from './commands/guide.js';
import { registerWhy } from './commands/why.js';
import { registerBisect } from './commands/bisect.js';
import { registerDrift } from './commands/drift.js';
import { registerModels } from './commands/models.js';
import { registerSavings } from './commands/savings.js';
import { registerLib } from './commands/lib.js';
import { registerExport } from './commands/export.js';
import { registerBundle } from './commands/bundle.js';
import { CliError, ExitCode } from './util/exit.js';
import { c, info, disableColor } from './util/output.js';

// Drift-reporting commands (merged from the Vibgrate CLI). These run on the
// open base engine (`@vibgrate/core-open`) — no proprietary kernel.
import { initCommand } from './reporting/commands/init.js';
import { scanCommand } from './reporting/commands/scan.js';
import { fixCommand } from './reporting/commands/fix.js';
import { baselineCommand } from './reporting/commands/baseline.js';
import { reportCommand } from './reporting/commands/report.js';
import { dsnCommand } from './reporting/commands/dsn.js';
import { loginCommand } from './reporting/commands/login.js';
import { logoutCommand } from './reporting/commands/logout.js';
import { pushCommand } from './reporting/commands/push.js';
import { updateCommand } from './reporting/commands/update.js';
import { sbomCommand } from './reporting/commands/sbom.js';

/** The set of registered subcommand names (kept in sync with registration). */
export const KNOWN_COMMANDS = new Set([
  'build',
  'status',
  'ask',
  'embed',
  'show',
  'path',
  'tree',
  'impact',
  'unknowns',
  'tests',
  'facts',
  'guide',
  'why',
  'bisect',
  'drift',
  'models',
  'savings',
  'lib',
  'export',
  'push',
  'bundle',
  'map',
  'hubs',
  'areas',
  'oddities',
  'serve',
  'lsp',
  'install',
  'uninstall',
  'share',
  'benchmark',
  'help',
  // Drift-reporting verbs (merged from the Vibgrate CLI).
  'init',
  'scan',
  'fix',
  'baseline',
  'report',
  'login',
  'logout',
  'dsn',
  'update',
  'sbom',
]);

export function buildProgram(): Command {
  const program = new Command();
  program
    .name('vg')
    .description(
      'vg — local codebase intelligence for AI coding agents: a deterministic, ' +
        'no-API-key code graph + MCP server, drift reporting, and version-correct library docs',
    )
    .version(VERSION, '--version', 'output the version number')
    .showSuggestionAfterError(true)
    .addHelpText('after', () => {
      // Show commands with the prefix that actually runs this CLI for the reader:
      // `vg` when installed, `npx @vibgrate/cli` when they invoked it via npx.
      const cli = resolveCliInvocation();
      const aliasNote =
        cli === 'vg'
          ? 'The `vibgrate` command is an alias for `vg`.\n'
          : cli === NPX_INVOCATION
            ? 'Install globally (`npm i -g @vibgrate/cli`) to use the shorter `vg` command.\n'
            : '';
      return (
        `\nRun \`${cli}\` to scan + map the current folder, \`${cli} "<question>"\` to ask, ` +
        `\`${cli} status\` for state, \`${cli} build --verify\` to re-verify the map.\n` +
        `Drift: \`${cli} scan\` / \`${cli} report\`. Wire into your AI agent: \`${cli} install\`.\n` +
        `${aliasNote}Docs: https://vibgrate.com/help`
      );
    });

  // Global flags live on each subcommand (see cli-options.applyGlobalOptions),
  // so the dispatch can place the command token first and let flags follow.
  registerBuild(program);
  registerStatus(program);
  registerAsk(program);
  registerEmbed(program);
  registerShow(program);
  registerPath(program);
  registerTree(program);
  registerInsights(program);
  registerImpact(program);
  registerUnknowns(program);
  registerServe(program);
  registerLsp(program);
  registerInstall(program);
  registerShare(program);
  registerBenchmark(program);
  registerTests(program);
  registerFacts(program);
  registerGuide(program);
  registerWhy(program);
  registerBisect(program);
  registerDrift(program);
  registerModels(program);
  registerSavings(program);
  registerLib(program);
  registerExport(program);
  registerBundle(program);

  // Drift-reporting commands (merged from the Vibgrate CLI). `push` here is the
  // real scan-artifact upload, so it replaces the graph engine's no-op `push`.
  program.addCommand(initCommand);
  program.addCommand(scanCommand);
  program.addCommand(fixCommand);
  program.addCommand(baselineCommand);
  program.addCommand(reportCommand);
  program.addCommand(loginCommand);
  program.addCommand(logoutCommand);
  program.addCommand(dsnCommand);
  program.addCommand(pushCommand);
  program.addCommand(updateCommand);
  program.addCommand(sbomCommand);

  return program;
}

/**
 * The "simple as Google" dispatch (VG-CLI-SPEC §1):
 *   vg                      → scan + map the current folder
 *   vg <path-that-exists>   → scan + map that path
 *   vg "<quoted question>"  → ask (contains a space or ends with '?')
 *   vg <known-command> …    → run that command
 *   vg <other-word>         → ask (bare-string search)
 */
/**
 * Flags that consume the following token as their value. Includes global flags
 * and command-level value options, so the dispatcher never mistakes a flag's
 * value (e.g. the `4` in `vg --jobs 4`) for the command/positional.
 */
const VALUE_FLAGS = new Set([
  '-C',
  '--cwd',
  '--generated-at',
  '--graph',
  '--jobs',
  '--only',
  '--exclude',
  '--export',
  '-o',
  '--budget',
  '-b',
]);

/**
 * Build-only flags that `scan` has no equivalent for. When one of these appears
 * on an otherwise-default invocation (`vg --json`, `vg --jobs 4`, `vg . --only ts`),
 * we keep routing to `build` so the flag still means "map", rather than handing
 * it to `scan` (which would reject the unknown option).
 */
const BUILD_ONLY_FLAGS = new Set([
  '--json',
  '--jobs',
  '--only',
  '--export',
  '--graph',
  '--generated-at',
  '--no-cache',
  '--deep',
  '--scip',
  '--no-scip',
  '--tsc',
  '--no-tsc',
  '--ground',
  '--no-ground',
  '--html',
  '--no-html',
  '--report',
  '--no-report',
  '--warm',
]);

function hasBuildOnlyFlag(args: string[]): boolean {
  return args.some((a) => BUILD_ONLY_FLAGS.has(a.split('=')[0]));
}

export function dispatch(argv: string[], cwd: string): string[] {
  const args = [...argv];
  const firstPositionalIdx = findFirstPositional(args);

  // No positional at all (e.g. `vg`, `vg --quiet`): default to scan, which also
  // builds the map (one command → DriftScore + AI/docs index). A terminal flag
  // like --help/--version is left for commander; a build-only flag keeps `build`.
  if (firstPositionalIdx === -1) {
    if (args.includes('--help') || args.includes('-h') || args.includes('--version')) {
      return args;
    }
    return [hasBuildOnlyFlag(args) ? 'build' : 'scan', ...args];
  }

  const first = args[firstPositionalIdx];

  // Explicit command → move it to the front (commander needs the command first;
  // global flags live on the subcommand so they can follow in any order).
  if (KNOWN_COMMANDS.has(first)) {
    const rest = [...args];
    rest.splice(firstPositionalIdx, 1);
    return [first, ...rest];
  }

  const looksLikeQuestion = /\s/.test(first) || first.endsWith('?');
  if (looksLikeQuestion) return ['ask', ...args];

  // A path (relative to cwd) → scan + map it (a build-only flag keeps `build`).
  if (fs.existsSync(path.resolve(cwd, first))) {
    return [hasBuildOnlyFlag(args) ? 'build' : 'scan', ...args];
  }

  // Recently-moved verbs: a migration hint beats a confusing search fall-through.
  const moved = MOVED_COMMANDS[first];
  if (moved) {
    throw new CliError(`\`vg ${first}\` has moved to \`${moved}\``, ExitCode.USAGE_ERROR);
  }

  // Bare word that is neither a command nor a path → treat as a search query.
  return ['ask', ...args];
}

/** Verbs folded into the build lifecycle — guide the user to the new form. */
const MOVED_COMMANDS: Record<string, string> = {
  verify: 'vg build --verify',
  attest: 'vg build --attest',
};

/** The first real positional, skipping value-taking global flags and their values. */
function findFirstPositional(args: string[]): number {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('-')) {
      // `--flag=value` consumes nothing extra; a bare value-flag consumes next.
      if (VALUE_FLAGS.has(a)) i++;
      continue;
    }
    return i;
  }
  return -1;
}

export async function main(argv = process.argv): Promise<void> {
  const raw = argv.slice(2);

  // Honor NO_COLOR / --no-color early so even bootstrap messages obey it.
  if (process.env.NO_COLOR || raw.includes('--no-color')) disableColor();

  // We need cwd for path-based dispatch; read -C/--cwd from the raw args.
  const cwd = readCwd(raw);

  const program = buildProgram();
  program.exitOverride((err) => {
    throw err;
  });
  // Route commander's own output through our streams; errors are handled below.
  program.configureOutput({
    writeErr: (str) => process.stderr.write(str),
    writeOut: (str) => process.stdout.write(str),
  });

  try {
    // dispatch() can throw (e.g. a moved-command hint) — keep it inside the
    // handler so those surface as a clean `error:` line, not a raw stack.
    const dispatched = dispatch(raw, cwd);
    await program.parseAsync(dispatched, { from: 'user' });
  } catch (err) {
    handleError(err);
  }
}

function readCwd(raw: string[]): string {
  const i = raw.findIndex((a) => a === '-C' || a === '--cwd');
  if (i >= 0 && raw[i + 1]) return path.resolve(raw[i + 1]);
  const eq = raw.find((a) => a.startsWith('--cwd='));
  if (eq) return path.resolve(eq.slice('--cwd='.length));
  return process.cwd();
}

function handleError(err: unknown): never {
  if (err instanceof CommanderError) {
    // Help/version are not errors.
    if (err.code === 'commander.helpDisplayed' || err.code === 'commander.help') {
      process.exit(ExitCode.OK);
    }
    if (err.code === 'commander.version') process.exit(ExitCode.OK);
    // Unknown command / bad option / missing argument → usage error.
    process.exit(ExitCode.USAGE_ERROR);
  }
  if (err instanceof CliError) {
    info(c.red(`error: ${err.message}`));
    process.exit(err.code);
  }
  const message = err instanceof Error ? err.message : String(err);
  const correlation = Math.random().toString(36).slice(2, 10);
  info(c.red(`error: ${message}`));
  info(c.dim(`  (ref ${correlation}) — re-run with --json for detail, or report at https://vibgrate.com/help`));
  process.exit(ExitCode.ERROR);
}

// Export for programmatic/default-build use and tests.
export { runBuild };

// Run only when invoked as the process entry (not when imported by a test or
// the embedding API). Robust across dev (tsx .ts), the built bin, and bin
// symlinks by comparing realpaths.
function isEntry(): boolean {
  try {
    if (!process.argv[1]) return false;
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isEntry()) {
  void main();
}
