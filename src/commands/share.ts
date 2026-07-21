import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Command } from 'commander';
import { applyGlobalOptions, readGlobal } from '../cli-options.js';
import { rootOf } from './util.js';
import { CliError, ExitCode } from '../util/exit.js';
import { c, info } from '../util/output.js';

/**
 * `vg share` (VG-CLI-SPEC §3.8) — make the map committable + self-updating for
 * the team. Installs:
 *   - a pre-commit hook that rebuilds and stages `graph.json` *only when it
 *     changed* (deterministic, no LLM → no token burn, no churn on no-op commits);
 *   - a deterministic merge driver: on conflict it rebuilds the graph from the
 *     merged code (the graph is a pure function of code) instead of corrupting
 *     JSON with a naive union;
 *   - `.vibgrate/.gitignore` keeping `cache/` and volatile artifacts out of git
 *     while committing the stable `graph.json` (prompt-cache safe).
 */

const HOOK_BEGIN = '# vg:begin';
const HOOK_END = '# vg:end';

export function registerShare(program: Command): void {
  const cmd = program
    .command('share')
    .description('make the map committable + auto-updating for your team (git)')
    .option('--undo', 'reverse what `vg share` installed')
    .option('--reports', 'also commit graph.html / GRAPH_REPORT.md (default: gitignored)')
    .action(function (this: Command, opts: { undo?: boolean; reports?: boolean }) {
      const global = readGlobal(this);
      const root = rootOf(global);
      const gitDir = path.join(root, '.git');
      if (!fs.existsSync(gitDir)) {
        throw new CliError('not a git repository — run `vg share` inside a git repo', ExitCode.USAGE_ERROR);
      }

      if (opts.undo) {
        undo(root);
        info(`${c.cyan('vg share')} ${c.dim('--undo')} · removed hooks, merge driver, and attributes`);
        return;
      }

      writeVibgrateGitignore(root, !!opts.reports);
      writeGitAttributes(root);
      configureMergeDriver(root);
      installPreCommitHook(root);

      info(`${c.cyan('vg share')} · the map is now committable + auto-updating`);
      info(`  ${c.green('✔')} .vibgrate/.gitignore (cache + volatile artifacts ignored, graph.json committed)`);
      info(`  ${c.green('✔')} pre-commit hook (rebuilds + stages graph.json only when it changed)`);
      info(`  ${c.green('✔')} deterministic merge driver for .vibgrate/graph.json (rebuild on conflict)`);
      info(c.dim('  commit .vibgrate/graph.json so teammates inherit the map on pull'));
    });
  applyGlobalOptions(cmd);
}

// Deliberately overwrites the default create-once ignore file (see
// ensureVibgrateGitignore): sharing is the explicit opt-in that flips
// graph.json from ignored-by-default to committed.
function writeVibgrateGitignore(root: string, reports: boolean): void {
  const dir = path.join(root, '.vibgrate');
  fs.mkdirSync(dir, { recursive: true });
  const lines = ['# Managed by `vg share` — keep graph.json committed, ignore the rest', 'cache/', 'facts.jsonl'];
  if (!reports) lines.push('graph.html', 'GRAPH_REPORT.md');
  fs.writeFileSync(path.join(dir, '.gitignore'), `${lines.join('\n')}\n`);
}

function writeGitAttributes(root: string): void {
  const file = path.join(root, '.gitattributes');
  const line = '.vibgrate/graph.json merge=vg';
  let content = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (!content.split('\n').some((l) => l.trim() === line)) {
    content = content.length ? `${content.replace(/\s*$/, '')}\n${line}\n` : `${line}\n`;
    fs.writeFileSync(file, content);
  }
}

function configureMergeDriver(root: string): void {
  // The graph is a pure function of code, so the correct merge is a rebuild.
  git(root, ['config', 'merge.vg.name', 'vg deterministic graph rebuild']);
  git(root, ['config', 'merge.vg.driver', 'vg build >/dev/null 2>&1; cp .vibgrate/graph.json %A']);
}

function installPreCommitHook(root: string): void {
  const hooksDir = hookDir(root);
  fs.mkdirSync(hooksDir, { recursive: true });
  const file = path.join(hooksDir, 'pre-commit');
  const block = [
    HOOK_BEGIN,
    'if command -v vg >/dev/null 2>&1; then',
    '  vg build >/dev/null 2>&1 || true',
    '  git add .vibgrate/graph.json >/dev/null 2>&1 || true',
    'fi',
    HOOK_END,
  ].join('\n');

  let content = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '#!/bin/sh\n';
  const re = new RegExp(`${escapeRe(HOOK_BEGIN)}[\\s\\S]*?${escapeRe(HOOK_END)}`);
  if (re.test(content)) content = content.replace(re, block);
  else content = `${content.replace(/\s*$/, '')}\n\n${block}\n`;
  if (!content.startsWith('#!')) content = `#!/bin/sh\n${content}`;
  fs.writeFileSync(file, content);
  fs.chmodSync(file, 0o755);
}

function undo(root: string): void {
  // Remove hook block.
  const hookFile = path.join(hookDir(root), 'pre-commit');
  if (fs.existsSync(hookFile)) {
    const re = new RegExp(`\\n*${escapeRe(HOOK_BEGIN)}[\\s\\S]*?${escapeRe(HOOK_END)}\\n*`);
    const next = fs.readFileSync(hookFile, 'utf8').replace(re, '\n');
    if (next.trim() === '#!/bin/sh') fs.rmSync(hookFile);
    else fs.writeFileSync(hookFile, next);
  }
  // Remove .gitattributes line.
  const attr = path.join(root, '.gitattributes');
  if (fs.existsSync(attr)) {
    const next = fs
      .readFileSync(attr, 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '.vibgrate/graph.json merge=vg')
      .join('\n');
    fs.writeFileSync(attr, next);
  }
  // Drop git config (ignore errors if absent).
  try {
    git(root, ['config', '--remove-section', 'merge.vg']);
  } catch {
    /* section may not exist */
  }
}

function hookDir(root: string): string {
  // Respect a configured hooks path (e.g. husky) when set.
  try {
    const configured = git(root, ['config', '--get', 'core.hooksPath']).trim();
    if (configured) return path.resolve(root, configured);
  } catch {
    /* not set */
  }
  return path.join(root, '.git', 'hooks');
}

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
