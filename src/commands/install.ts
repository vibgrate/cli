import { Command } from 'commander';
import { loadGraph } from '../engine/load.js';
import { ASSISTANTS, assistantById, installAssistant, uninstallAssistant } from '../install/registry.js';
import { applyGlobalOptions, readGlobal } from '../cli-options.js';
import { rootOf } from './util.js';
import { CliError, ExitCode, usageError } from '../util/exit.js';
import { c, info, json } from '../util/output.js';

const SMALL_REPO_FILES = 150;

/**
 * `vg install <tool…>` (VG-CLI-SPEC §3.7) — wire vg into AI assistants: a skill,
 * an advisory (opt-out) nudge, and an MCP registration where supported.
 * Idempotent; repo-local (the team-shareable default). On small repos the nudge
 * honestly says searching is fine.
 */
export function registerInstall(program: Command): void {
  const install = program
    .command('install')
    .description('add vg to your AI assistant(s): skill + MCP + advisory nudge')
    .argument('[tools...]', 'assistant ids (claude, cursor, windsurf, vscode, codex, gemini)')
    .option('--all', 'install for every supported assistant')
    .option('--list', 'show the support matrix and exit')
    .option('--no-hook', 'skip the advisory nudge')
    .action(function (this: Command, tools: string[], opts: { all?: boolean; list?: boolean; hook?: boolean }) {
      const global = readGlobal(this);
      const root = rootOf(global);

      if (opts.list) {
        if (global.json) {
          json(ASSISTANTS.map((a) => ({ id: a.id, label: a.label, mcp: !!a.mcp, skill: !!a.skill, nudge: !!a.nudge })));
        } else {
          info(`${c.cyan('vg install')} · supported assistants`);
          for (const a of ASSISTANTS) {
            info(`  ${c.bold(a.id.padEnd(10))} ${a.label}  ${c.dim(`mcp:${a.mcp ? '✓' : '—'} skill:${a.skill ? '✓' : '—'} nudge:${a.nudge ? '✓' : '—'}`)}`);
          }
        }
        return;
      }

      const targets = opts.all ? ASSISTANTS : tools.map(resolve);
      if (targets.length === 0) throw usageError('name an assistant (e.g. `vg install claude`) or use --all / --list');

      const graph = loadGraph(root, global.graph);
      const fileCount = graph ? graph.nodes.filter((n) => n.kind === 'file').length : 0;
      const smallRepo = graph !== null && fileCount > 0 && fileCount < SMALL_REPO_FILES;

      const results = targets.map((a) => ({ id: a.id, ...installAssistant(a, { root, hook: opts.hook, smallRepo }) }));

      if (global.json) {
        json({ root, smallRepo, results });
        return;
      }
      for (const r of results) {
        info(`${c.green('✔')} ${c.bold(r.id)} — wrote ${r.wrote.join(', ')}${r.skipped.length ? c.dim(` (skipped ${r.skipped.join(', ')})`) : ''}`);
      }
      if (smallRepo) info(c.dim(`  note: small repo (${fileCount} files) — nudge says searching is fine; vg is still used for impact/tests`));
      info(c.dim('  run `vg serve` is wired via MCP; build the map with `vg` if you have not yet'));
    });
  applyGlobalOptions(install);

  const uninstall = program
    .command('uninstall')
    .description('remove vg from an AI assistant')
    .argument('<tools...>', 'assistant ids')
    .option('--purge', 'also delete the skill file')
    .action(function (this: Command, tools: string[], opts: { purge?: boolean }) {
      const global = readGlobal(this);
      const root = rootOf(global);
      const results = tools.map(resolve).map((a) => ({ id: a.id, removed: uninstallAssistant(a, root, !!opts.purge) }));
      if (global.json) {
        json({ root, results });
        return;
      }
      for (const r of results) {
        info(`${c.green('✔')} ${c.bold(r.id)} — removed ${r.removed.length ? r.removed.join(', ') : c.dim('nothing (not installed)')}`);
      }
    });
  applyGlobalOptions(uninstall);
}

function resolve(id: string) {
  const a = assistantById(id);
  if (!a) {
    throw new CliError(
      `unknown assistant "${id}". Supported: ${ASSISTANTS.map((x) => x.id).join(', ')} (see \`vg install --list\`)`,
      ExitCode.USAGE_ERROR,
    );
  }
  return a;
}
