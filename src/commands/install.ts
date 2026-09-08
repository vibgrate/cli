import { Command } from 'commander';
import { loadGraph } from '../engine/load.js';
import {
  ASSISTANTS,
  SMALL_REPO_FILES,
  assistantById,
  detectAssistants,
  detectServeLaunch,
  installAssistant,
  isAssistantInstalled,
  uninstallAssistant,
  writeNavigationConfig,
} from '../install/registry.js';
import { applyGlobalOptions, readGlobal } from '../cli-options.js';
import { installClaudeHooks, uninstallClaudeHooks } from '../install/hooks.js';
import { rootOf } from './util.js';
import { CliError, ExitCode, usageError } from '../util/exit.js';
import { c, info, json } from '../util/output.js';
import { applyProxyToAgent, isWrapAgent, unwrap, loginCopilot, type DurableScope } from '../wrap/index.js';
import { env as knobEnv } from '../compress/config.js';

/**
 * `vg install <tool…>` (VG-CLI-SPEC §3.7) — wire vg into AI assistants: a skill,
 * an advisory (opt-out) nudge, and an MCP registration where supported.
 * Idempotent; repo-local (the team-shareable default). On small repos the nudge
 * honestly says searching is fine.
 *
 * `install` owns the outcome "agent config written" (FEATURE-DESIGN-PRINCIPLES
 * P1), so everything that writes an agent's configuration lands here rather
 * than in a verb of its own:
 *
 *   --compress   also point the agent's base URL at the local compression
 *                listener, durably and reversibly (marker-tracked, so
 *                `vg uninstall` restores the file byte-for-byte)
 *   --learn      rewrite the agent's guardrails from what past sessions
 *                actually got wrong (preview unless --apply)
 *
 * The per-session equivalent of `--compress` is `vg serve --compress -- <agent>`,
 * which sets the environment for one run and writes nothing.
 */
export function registerInstall(program: Command): void {
  const install = program
    .command('install')
    .description('add vg to your AI assistant(s): skill + MCP + advisory nudge')
    .argument('[tools...]', `assistant ids: ${ASSISTANTS.map((a) => a.id).join(', ')}`)
    .option('--all', 'install for every supported assistant')
    .option('--detect', 'detect assistants in use (repo footprint, home config, PATH) and install for those; with --list, only report what was detected')
    .option('--list', 'show the support matrix and exit')
    .option('--no-hook', 'skip the advisory nudge')
    .option('--hooks', 'also wire the PreToolUse enrichment hook (Claude Code): Grep/Glob calls get graph context via `vg hook pre-tool-use` (project .claude/settings.json; opt-in)')
    .option('--compress [url]', 'also route the assistant through the local compression listener (writes its base-URL config; default url from VG_PROXY_URL / VG_PROXY_PORT). Undo with `vg uninstall <agent>`')
    .option('--compress-scope <scope>', 'where --compress writes: project (repo-local, default) or user (home config)', 'project')
    .option('--login', 'copilot: sign in to GitHub with the device flow before writing the routing')
    .option('--learn', 'rewrite the assistant’s guardrails from what past sessions got wrong (preview unless --apply)')
    .option('--apply', 'with --learn: write the guardrails block (default: preview only)')
    .option('--since <duration>', 'with --learn: only sessions active within this window (e.g. 7d, 48h, 2w)', '7d')
    .option('--min-evidence <n>', 'with --learn: occurrences before a non-loop pattern becomes a rule', '2')
    .option('--learn-target <file>', 'with --learn: instructions file to write (default: the assistant’s own — CLAUDE.local.md, AGENTS.md, GEMINI.md …)')
    .option('--all-projects', 'with --learn: scan sessions from every project, not just this repo')
    .action(async function (this: Command, tools: string[], opts: { all?: boolean; detect?: boolean; list?: boolean; hook?: boolean; hooks?: boolean; compress?: string | boolean; compressScope?: string; login?: boolean; learn?: boolean; apply?: boolean; since?: string; minEvidence?: string; learnTarget?: string; allProjects?: boolean }) {
      const global = readGlobal(this);
      const root = rootOf(global);
      if (opts.compressScope !== undefined && opts.compressScope !== 'project' && opts.compressScope !== 'user') {
        throw usageError(`--compress-scope must be project or user (got ${JSON.stringify(opts.compressScope)})`);
      }

      const detected = opts.detect ? detectAssistants(root) : [];

      if (opts.list) {
        if (opts.detect) {
          // Detection report only — nothing is written. This is what editor
          // integrations poll before deciding to run an install.
          if (global.json) {
            json(detected.map((d) => ({ id: d.assistant.id, label: d.assistant.label, via: d.via, marker: d.marker })));
          } else if (detected.length === 0) {
            info(`${c.cyan('vg install')} · no AI assistants detected here`);
          } else {
            info(`${c.cyan('vg install')} · detected assistants`);
            const pad = Math.max(...detected.map((d) => d.assistant.id.length)) + 2;
            for (const d of detected) {
              info(`  ${c.bold(d.assistant.id.padEnd(pad))} ${d.assistant.label}  ${c.dim(`via ${d.via}: ${d.marker}`)}`);
            }
          }
          return;
        }
        if (global.json) {
          json(
            ASSISTANTS.map((a) => ({
              id: a.id,
              label: a.label,
              mcp: !!a.mcp,
              skill: !!a.skill,
              nudge: !!a.nudge,
              installed: isAssistantInstalled(a, root),
            })),
          );
        } else {
          info(`${c.cyan('vg install')} · supported assistants`);
          const pad = Math.max(...ASSISTANTS.map((a) => a.id.length)) + 2;
          for (const a of ASSISTANTS) {
            const on = isAssistantInstalled(a, root) ? c.green('on') : c.dim('off');
            info(
              `  ${c.bold(a.id.padEnd(pad))} ${a.label}  ${on}  ${c.dim(`mcp:${a.mcp ? '✓' : '—'} skill:${a.skill ? '✓' : '—'} nudge:${a.nudge ? '✓' : '—'}`)}`,
            );
          }
        }
        return;
      }

      const targets = opts.all ? ASSISTANTS : opts.detect ? detected.map((d) => d.assistant) : tools.map(resolve);
      if (targets.length === 0) {
        if (opts.detect) {
          // Detecting nothing is a clean no-op, not a usage mistake.
          if (global.json) json({ root, detected: [], results: [] });
          else info(`${c.cyan('vg install')} · no AI assistants detected here — name one (e.g. \`vg install claude\`) or use --all`);
          return;
        }
        throw usageError('name an assistant (e.g. `vg install claude`) or use --all / --detect / --list');
      }

      const graph = loadGraph(root, global.graph);
      const fileCount = graph ? graph.nodes.filter((n) => n.kind === 'file').length : 0;
      const smallRepo = graph !== null && fileCount > 0 && fileCount < SMALL_REPO_FILES;

      // Detect once — every target registers the same launch command.
      const launch = detectServeLaunch();
      const results = targets.map((a) => ({ id: a.id, ...installAssistant(a, { root, hook: opts.hook, smallRepo, launch }) }));
      // Write the deferred-loading navigation config once (P3): a client-side
      // loading config for Claude-API agents that support defer_loading — the
      // server tool set is unchanged.
      const navConfig = writeNavigationConfig(root);

      // Copilot signs in before the routing is written, so a fresh machine
      // gets one command rather than a write followed by an auth failure.
      let signIn: { file: string; fingerprint: string; domain: string } | null = null;
      if (opts.login) {
        if (global.offline) throw usageError('--login needs the network; it cannot run under --local/--offline');
        signIn = await loginCopilot();
        if (!global.json) info(`${c.green('✔')} ${c.bold('copilot')} — signed in as ${signIn.fingerprint} ${c.dim(`(${signIn.file})`)}`);
      }

      // Opt-in durable compression routing: the assistant's own base-URL config
      // is pointed at the local compression listener (marker-tracked, so
      // `vg uninstall` restores it byte-for-byte). Assistants with no config
      // surface for a base URL are reported, not silently skipped.
      const compressRouting = opts.compress ? routeThroughCompression(targets.map((a) => a.id), opts.compress, (opts.compressScope as DurableScope | undefined) ?? 'project', root) : [];

      // Guardrails learned from past sessions. Same outcome family (agent
      // config written), so it is a mode of install, not a verb.
      const learned = opts.learn
        ? await runLearn(targets.map((a) => a.id), {
            root,
            apply: opts.apply === true,
            since: opts.since ?? '7d',
            minEvidence: opts.minEvidence,
            target: opts.learnTarget,
            allProjects: opts.allProjects === true,
            json: global.json === true,
          })
        : null;

      if (global.json) {
        json({
          root,
          smallRepo,
          navConfig,
          launch: { command: launch.command, args: launch.args, note: launch.note ?? null },
          results,
          ...(signIn ? { copilot: { file: signIn.file, fingerprint: signIn.fingerprint, domain: signIn.domain } } : {}),
          ...(opts.compress ? { compress: compressRouting } : {}),
          ...(learned ? { learn: learned } : {}),
        });
        return;
      }
      for (const r of results) {
        info(`${c.green('✔')} ${c.bold(r.id)} — wrote ${r.wrote.join(', ')}${r.skipped.length ? c.dim(` (skipped ${r.skipped.join(', ')})`) : ''}`);
      }
      for (const p of compressRouting) {
        if (p.status === 'written') info(`${c.green('✔')} ${c.bold(p.id)} — routed through ${p.url} via ${p.file}${p.fields.length ? c.dim(` (${p.fields.join(', ')})`) : ''}`);
        else if (p.status === 'unchanged') info(`${c.dim('·')} ${c.bold(p.id)} — already routed through ${p.url} ${c.dim(`(${p.file})`)}`);
        else info(`${c.yellow('!')} ${c.bold(p.id)} — ${p.note}`);
      }
      if (compressRouting.some((p) => p.status === 'written')) info(c.dim('  start the listener with `vg serve --compress`; undo the routing with `vg uninstall <agent>`'));
      // Opt-in PreToolUse enrichment (Claude Code settings format only): the
      // host's own Grep/Glob results arrive annotated with graph context.
      if (opts.hooks && targets.some((a) => a.id === 'claude')) {
        const vgBin = launch.command === 'npx' ? null : launch.command;
        const hooksResult = vgBin
          ? installClaudeHooks(root, vgBin)
          : ({ file: '.claude/settings.json', status: 'skipped', note: 'vg is not installed on PATH — hooks need a fast binary (npm i -g @vibgrate/cli), rerun with --hooks after' } as const);
        if (hooksResult.status === 'written') info(`${c.green('✔')} ${c.bold('hooks')} — wrote PreToolUse enrichment into ${hooksResult.file}`);
        else if (hooksResult.note) info(`${c.yellow('!')} hooks — ${hooksResult.note}`);
      }
      if (launch.note && results.some((r) => r.note)) info(`${c.yellow('!')} ${launch.note}`);
      if (smallRepo) info(c.dim(`  note: small repo (${fileCount} files) — nudge says searching is fine; vg is still used for impact/tests`));
      info(c.dim(`  wrote ${navConfig} — deferred-loading config for Claude-API agents (lower per-step token cost)`));
      info(c.dim('  run `vg serve` is wired via MCP; build the map with `vg` if you have not yet'));
    });
  applyGlobalOptions(install);

  const uninstall = program
    .command('uninstall')
    .description('remove vg from an AI assistant — skill, MCP registration, hooks and compression routing')
    .argument('<tools...>', 'assistant ids')
    .option('--purge', 'also delete the skill file')
    .option('--force', 'restore a routed config file even when another live session still holds it')
    .action(function (this: Command, tools: string[], opts: { purge?: boolean; force?: boolean }) {
      const global = readGlobal(this);
      const root = rootOf(global);
      const results = tools.map(resolve).map((a) => ({ id: a.id, removed: uninstallAssistant(a, root, !!opts.purge) }));
      // Uninstalling claude also removes the vg PreToolUse hook entries (ours
      // only — everything else in settings.json is preserved verbatim).
      if (tools.map(resolve).some((a) => a.id === 'claude')) {
        const hooksResult = uninstallClaudeHooks(root);
        if (hooksResult.status === 'written') results.find((r) => r.id === 'claude')?.removed.push(`${hooksResult.file} (vg hook entries)`);
      }
      // `install --compress` wrote the assistant's own base-URL config behind a
      // marker; uninstall is the one revert verb, so it restores that too.
      const restored = revertCompressionRouting(results.map((r) => r.id), root, opts.force === true);
      for (const rev of restored) {
        const row = results.find((r) => r.id === rev.id);
        for (const file of rev.files) row?.removed.push(`${file} (compression routing)`);
      }
      if (global.json) {
        json({ root, results, routing: restored });
        return;
      }
      for (const r of results) {
        info(`${c.green('✔')} ${c.bold(r.id)} — removed ${r.removed.length ? r.removed.join(', ') : c.dim('nothing (not installed)')}`);
      }
      const held = restored.flatMap((r) => r.skipped);
      for (const s of held) info(`${c.yellow('!')} skipped ${s}`);
      if (held.some((s) => s.includes('still in use'))) info(c.dim('  pass --force to restore anyway'));
    });
  applyGlobalOptions(uninstall);
}

interface CompressRouting {
  id: string;
  url: string;
  status: 'written' | 'unchanged' | 'unsupported' | 'failed';
  file?: string;
  fields: string[];
  note?: string;
}

/** The listener URL `--compress` writes: an explicit value, else `VG_PROXY_URL`, else host:port from the knobs. */
export function proxyUrlFor(explicit: string | boolean | undefined, env: NodeJS.ProcessEnv = process.env): string {
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim().replace(/\/+$/, '');
  const fromEnv = knobEnv.string('VG_PROXY_URL', env);
  if (fromEnv) return fromEnv.replace(/\/+$/, '');
  const host = knobEnv.string('VG_PROXY_HOST', env) ?? '127.0.0.1';
  const port = knobEnv.int('VG_PROXY_PORT', env, { min: 1, max: 65535 });
  return `http://${host}:${port}`;
}

/**
 * Assistant ids (`vg install <id>`) whose routing agent is registered under a
 * different name. Without `copilot-cli` here, installing GitHub Copilot CLI
 * with `--compress` reported "no base-URL config" even though the routing
 * exists — the two registries simply spell it differently.
 */
const WRAP_AGENT_ALIASES: Readonly<Record<string, string>> = {
  factory: 'droid',
  vscode: 'vscode-claude',
  'copilot-cli': 'copilot',
};

function routeThroughCompression(ids: string[], explicit: string | boolean, scope: DurableScope, root: string): CompressRouting[] {
  const url = proxyUrlFor(explicit);
  return ids.map((id): CompressRouting => {
    const agent = WRAP_AGENT_ALIASES[id] ?? id;
    const oneShot = `\`vg serve --compress -- ${id}\``;
    if (!isWrapAgent(agent)) return { id, url, status: 'unsupported', fields: [], note: `no compression routing for ${id} — it has no base-URL config vg can write; run it with ${oneShot} instead when supported` };
    try {
      const applied = applyProxyToAgent(agent, url, { scope, cwd: root });
      if (!applied) return { id, url, status: 'unsupported', fields: [], note: `${id} has no durable config for a base URL — use ${oneShot} for a per-session route` };
      return { id, url, status: applied.result.changed ? 'written' : 'unchanged', file: applied.file, fields: applied.result.fields };
    } catch (err) {
      return { id, url, status: 'failed', fields: [], note: `could not route ${id}: ${(err as Error).message}` };
    }
  });
}

interface RoutingRevert {
  id: string;
  files: string[];
  skipped: string[];
}

/** Undo whatever `install --compress` wrote for these assistants. */
function revertCompressionRouting(ids: string[], root: string, force: boolean): RoutingRevert[] {
  return ids
    .map((id): RoutingRevert => {
      const agent = WRAP_AGENT_ALIASES[id] ?? id;
      if (!isWrapAgent(agent)) return { id, files: [], skipped: [] };
      try {
        const r = unwrap(agent, { cwd: root, force });
        return { id, files: r.reverted.filter((x) => x.kind === 'file').map((x) => x.file), skipped: r.skipped };
      } catch (err) {
        return { id, files: [], skipped: [`${id}: ${(err as Error).message}`] };
      }
    })
    .filter((r) => r.files.length || r.skipped.length);
}

/**
 * `vg install <agent> --learn` — read the coding-agent sessions on this machine,
 * find what wasted tokens (loops, failing commands, wrong paths, corrections),
 * and write the guardrails into the assistant's own instructions file between
 * `<!-- vg:learn:begin -->` / `<!-- vg:learn:end -->`. Preview unless `--apply`.
 */
async function runLearn(
  ids: string[],
  opts: { root: string; apply: boolean; since: string; minEvidence?: string; target?: string; allProjects: boolean; json: boolean },
): Promise<unknown> {
  const { learnFromSessions } = await import('../learn/run.js');
  const result = await learnFromSessions({
    assistants: ids,
    root: opts.root,
    apply: opts.apply,
    since: opts.since,
    minEvidence: opts.minEvidence,
    target: opts.target,
    allProjects: opts.allProjects,
  });
  if (opts.json) return result;
  info('');
  info(`${c.cyan('vg install --learn')} · ${result.sessions} sessions ${c.dim(`(${result.agents.join(', ') || 'none found'})`)} · ${result.digest.toolCalls} tool calls · ${result.digest.failures} failures ${c.dim(`(${Math.round(result.digest.failureRate * 100)}%)`)}`);
  if (!result.sessions) {
    info(c.dim(`  no sessions in the last ${opts.since} — widen with --since 30d, or drop the repo filter with --all-projects`));
    return result;
  }
  if (result.digest.loops.length) {
    info(`  ${c.bold('loops')} ${result.digest.loops.length} · ~${result.digest.loops.reduce((a, l) => a + l.wastedTokens, 0).toLocaleString('en-US')} tokens wasted`);
    for (const lp of result.digest.loops.slice(0, 5)) info(c.dim(`    [${lp.kind}] ${lp.tool}: "${lp.sample}" ×${lp.count} (~${lp.wastedTokens.toLocaleString('en-US')} tokens)`));
  }
  for (const e of result.scanErrors) info(c.yellow(`  ${e}`));
  if (result.analyzerError) info(c.yellow(`  analyzer CLI failed — used the built-in analyzer: ${result.analyzerError.split('\n')[0]}`));
  if (!result.rules.length) {
    info(c.dim('  nothing to write: no repeated failures, loops or corrections in this window'));
    return result;
  }
  info('');
  for (const l of result.block.split('\n')) info(`  ${l}`);
  info('');
  if (!result.changed) info(c.dim(`  ${result.target} already up to date`));
  else if (opts.apply) info(`  ${c.green('applied')} → ${result.target}${result.created ? c.dim(' (created)') : ''}`);
  else {
    info(`  ${c.bold('preview')} → ${result.target}${result.created ? c.dim(' (would be created)') : ''}`);
    info(c.dim('  re-run with --apply to write it'));
  }
  if (result.verbosity) {
    info(`  ${c.bold('verbosity')} ${result.verbosity.suggested} ${c.dim(`(${result.verbosity.confidence}) — ${result.verbosity.rationale}`)}`);
    info(c.dim(result.verbosityFile ? `    saved → ${result.verbosityFile}` : `    apply with --apply, or set VG_OUTPUT_VERBOSITY_LEVEL=${result.verbosity.suggested}`));
  }
  return result;
}

function resolve(id: string) {
  const a = assistantById(id);
  if (!a) {
    const near = ASSISTANTS.filter(
      (x) => x.id.startsWith(id) || id.startsWith(x.id) || x.id.includes(id) || x.label.toLowerCase().includes(id.toLowerCase()),
    ).map((x) => x.id);
    const hint = near.length ? ` Did you mean: ${near.join(', ')}?` : '';
    throw new CliError(
      `unknown assistant "${id}".${hint} Supported: ${ASSISTANTS.map((x) => x.id).join(', ')} (see \`vg install --list\`)`,
      ExitCode.USAGE_ERROR,
    );
  }
  return a;
}
