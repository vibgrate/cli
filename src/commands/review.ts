/**
 * `vg review` — Vibgrate Review: architecture-aware change review that runs
 * locally (spec §3).
 *
 *   vg review                    changed-only vs HEAD (dirty tree + index)
 *   vg review --base origin/main merge-base of HEAD and base
 *   vg review explain <id>       the evidence behind one finding
 *
 * Exit codes are the CI contract and never conflate "missing" with "pass":
 *
 *   0  pass
 *   1  fail (and, with `--fail-on needs_review`, needs_review / undetermined)
 *   2  needs_review or undetermined
 *   6  missing graph, policy, or a required model
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Command } from 'commander';
import { applyGlobalOptions, readGlobal } from '../cli-options.js';
import { CliError, ExitCode } from '../util/exit.js';
import { c, info, out } from '../util/output.js';
import { rootOf } from './util.js';
import { formatExplain, formatMarkdown, formatSarif, formatText, type ReviewFormat } from '../review/format.js';
import { exitCodeForDecision, resolveFailOn, FAIL_ON_LEVELS, type FailOnLevel } from '../review/policy.js';
import { buildEnvelope, collectSpans, pushReceipt, rejectPushWhenOffline, type ReviewPushBody } from '../review/push.js';
import { runReview, type RunReviewResult } from '../review/run.js';
import { injectContextBlock, renderContext, writeContextFile } from '../review/context-file.js';
import { ensureCodeMap, reviewPolicyState, seedReviewPolicy } from '../review/prepare.js';
import { defaultRun } from '../review/git.js';
import { parseDsn } from '../reporting/commands/push.js';
import { resolveDsn } from '../reporting/credentials.js';

interface ReviewOpts {
  base?: string;
  format: ReviewFormat;
  /** `-o, --out <file>`. Commander derives the key from the long flag, so this
   *  must stay named `out` — naming it `outFile` silently ignores the flag. */
  out?: string;
  push?: boolean;
  failOn?: FailOnLevel;
  explain?: boolean;
  dsn?: string;
  strict?: boolean;
  includeSpans?: boolean;
  includeSnippets?: boolean;
  writeContext?: boolean;
  injectContext?: string | boolean;
  /** `--no-auto-build`; commander sets this false. */
  autoBuild?: boolean;
  /** `--no-setup`; commander sets this false. */
  setup?: boolean;
}

const FORMATS: ReviewFormat[] = ['text', 'json', 'sarif', 'md'];

export function registerReview(program: Command): void {
  const cmd = program
    .command('review')
    .description('Vibgrate Review — architecture + security-control review of the current change, locally')
    .option('--base <ref>', 'review HEAD against the merge-base with <ref> (e.g. origin/main)')
    .option('--format <fmt>', `output format (${FORMATS.join(' | ')})`, 'text')
    .option('-o, --out <file>', 'write the formatted result to a file')
    .option('--push', 'send the receipt to Vibgrate Cloud (needs a DSN)')
    .option(
      '--fail-on <level>',
      'gate CI on this decision level (none | fail | needs_review). Omit to use .vibgrate/review.toml; gating is off unless enforcement = "enforced"',
    )
    .option('--explain', 'add local-model explanations (requires a local model; fails closed without one)')
    .option('--dsn <dsn>', 'DSN token for --push (or use VIBGRATE_DSN / `vg login`)')
    .option('--strict', 'fail the command when --push fails')
    .option('--include-spans', 'include evidence line ranges in the pushed receipt')
    .option('--include-snippets', 'include capped source snippets in the pushed receipt (explicit opt-in)')
    .option('--no-auto-build', 'do not build or refresh the code map — fail with exit 6 when it is missing or stale')
    .option('--no-setup', 'do not write a starter .vibgrate/review.toml when the repository has no review policy')
    .option('--write-context', 'write .vibgrate/review-context.md — committed agent memory')
    .option(
      '--inject-context [file]',
      'update the managed review block inside an instruction file (default: CLAUDE.md)',
    )
    .action(async function (this: Command, opts: ReviewOpts) {
      const global = readGlobal(this);
      const root = rootOf(global);

      if (!FORMATS.includes(opts.format)) {
        throw new CliError(`unknown --format "${opts.format}" (expected ${FORMATS.join(', ')})`, ExitCode.USAGE_ERROR);
      }

      const prepared = await ensureCodeMap({
        root,
        graphPath: global.graph,
        autoBuild: opts.autoBuild,
        quiet: Boolean(global.quiet) || Boolean(global.json),
      });
      reportPrepare(prepared, Boolean(global.quiet) || Boolean(global.json));

      const result = await runReview({
        root,
        base: opts.base,
        explain: opts.explain,
        offline: global.offline,
        graphPath: global.graph,
        generatedAt: global.generatedAt,
      });

      if (opts.failOn && !FAIL_ON_LEVELS.includes(opts.failOn)) {
        throw new CliError(
          `unknown --fail-on "${opts.failOn}" (expected ${FAIL_ON_LEVELS.join(', ')})`,
          ExitCode.USAGE_ERROR,
        );
      }
      // Gating is opt-in, like `vg scan`: without `--fail-on` or
      // `enforcement = "enforced"`, the decision is reported and the process
      // still exits 0.
      const failOn = resolveFailOn(opts.failOn, result.config);

      const format = global.json ? 'json' : opts.format;
      const rendered = render(result, format);

      if (opts.out) {
        // `--out` is the destination. Writing the same bytes to stdout as well
        // would mean a CI step that redirects stdout silently gets the document
        // twice, so the terminal gets the human summary instead.
        const target = path.resolve(root, opts.out);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, `${rendered}\n`, 'utf8');
        if (!global.quiet) {
          info(formatText(result));
          info(c.dim(`  ${format} written to ${opts.out}`));
        }
      } else if (format === 'text') {
        // Human output on stderr, machine output on stdout — so
        // `vg review --format json > receipt.json` is a clean pipe.
        if (!global.quiet) info(rendered);
      } else {
        out(rendered);
      }

      // Seeded *after* the review, so the file this run writes never shows up
      // in the change set this run is reviewing — it is set up for the next one.
      maybeSeedPolicy(result, opts, Boolean(global.quiet) || Boolean(global.json));

      if (opts.writeContext || opts.injectContext) writeAgentContext(result, opts, Boolean(global.quiet));

      if (opts.push) {
        rejectPushWhenOffline(global.offline);
        await doPush(root, result, opts, Boolean(global.quiet));
      }

      const code = exitCodeForDecision(result.receipt.decision, failOn);
      if (code !== 0) {
        info(c.red(`\nFailing: review decision is \`${result.receipt.decision}\` and the gate is \`${failOn}\`.`));
        process.exitCode = code;
      }
    });
  applyGlobalOptions(cmd);

  const explain = cmd
    .command('explain')
    .description('show the evidence behind one finding from the current change')
    .argument('<finding-id>', 'a finding id from the last `vg review` run (e.g. arch-01)')
    .option('--base <ref>', 'review HEAD against the merge-base with <ref>')
    .action(async function (this: Command, findingId: string, opts: { base?: string }) {
      const global = readGlobal(this);
      const explainRoot = rootOf(global);
      reportPrepare(
        await ensureCodeMap({
          root: explainRoot,
          graphPath: global.graph,
          quiet: Boolean(global.quiet) || Boolean(global.json),
        }),
        Boolean(global.quiet) || Boolean(global.json),
      );
      const result = await runReview({
        root: explainRoot,
        base: opts.base,
        offline: global.offline,
        graphPath: global.graph,
        generatedAt: global.generatedAt,
      });
      const text = formatExplain(result, findingId);
      if (!text) {
        throw new CliError(
          `no finding "${findingId}" in this change set — run \`vg review\` to list the current findings`,
          ExitCode.NOT_FOUND,
        );
      }
      if (global.json) {
        const all = [...result.receipt.findings.architecture_findings, ...result.receipt.findings.security_findings];
        const finding = all.find((f) => f.id === findingId)!;
        out(
          JSON.stringify(
            {
              finding,
              evidence: result.capsule.evidence.filter((e) => finding.evidence_ids.includes(e.id)),
            },
            null,
            2,
          ),
        );
        return;
      }
      info(text);
    });
  applyGlobalOptions(explain);
}

/**
 * One line about what auto-prep did, and only when it did something. A review
 * that found a fresh map says nothing — the common case should be silent.
 */
function reportPrepare(prepared: Awaited<ReturnType<typeof ensureCodeMap>>, quiet: boolean): void {
  if (quiet) return;
  const secs = prepared.ms === undefined ? '' : ` in ${(prepared.ms / 1000).toFixed(1)}s`;
  if (prepared.action === 'built') {
    info(c.dim(`  code map built — ${prepared.files} files${secs}`));
  } else if (prepared.action === 'refreshed') {
    info(c.dim(`  code map refreshed — ${prepared.files} files${secs}`));
  } else if (prepared.action === 'skipped' && prepared.reason) {
    info(c.yellow(`  code map not built: ${prepared.reason}`));
  }
}

/**
 * First run in a repository with no review policy: write the starter
 * `.vibgrate/review.toml` and say so. Skipped for `--base` runs (a PR review
 * must not mutate the tree it is reviewing) and under `--no-setup`.
 */
function maybeSeedPolicy(result: RunReviewResult, opts: ReviewOpts, quiet: boolean): void {
  if (opts.setup === false || opts.base) return;
  if (result.config.source !== 'defaults') return;
  if (reviewPolicyState(result.repoRoot, undefined, defaultRun).present) return;

  const seeded = seedReviewPolicy({
    root: result.repoRoot,
    observedPattern: result.capsule.patterns.observed_dominant_pattern,
  });
  if (!seeded.written || quiet) return;
  info(
    c.green(`\n  Review baseline ready — wrote ${seeded.path}`)
      + c.dim(
        seeded.targetPattern
          ? `\n  target_pattern = "${seeded.targetPattern}" (derived from this repository). Edit it, commit it,`
            + '\n  and future changes are judged against a declared architecture rather than a guess.'
          : '\n  No layering shape dominates yet, so target_pattern is left commented out.'
            + '\n  Set one and commit the file to have future changes judged against it.',
      ),
  );
}

function render(result: RunReviewResult, format: ReviewFormat): string {
  if (format === 'json') return JSON.stringify(result.receipt, null, 2);
  if (format === 'sarif') return formatSarif(result.receipt);
  if (format === 'md') return formatMarkdown(result);
  return formatText(result);
}

async function doPush(
  root: string,
  result: RunReviewResult,
  opts: ReviewOpts,
  quiet: boolean,
): Promise<void> {
  const dsn = resolveDsn(opts.dsn);
  if (!dsn) {
    const message = 'no DSN for --push — run `vg login`, set VIBGRATE_DSN, or pass --dsn';
    if (opts.strict) throw new CliError(message, ExitCode.USAGE_ERROR);
    info(c.yellow(`  ${message}`));
    return;
  }
  const parsed = parseDsn(dsn);
  if (!parsed) {
    const message = 'invalid DSN format (expected vibgrate+https://<key>:<secret>@<host>/<workspace>)';
    if (opts.strict) throw new CliError(message, ExitCode.USAGE_ERROR);
    info(c.yellow(`  ${message}`));
    return;
  }

  const envelope = buildEnvelope(result.receipt, {
    workspaceId: parsed.workspaceId,
    pushedAt: new Date().toISOString(),
  });
  const body: ReviewPushBody = { ...envelope };
  const spans = collectSpans(root, result.receipt, result.capsule, {
    includeSpans: opts.includeSpans,
    includeSnippets: opts.includeSnippets,
  });
  if (spans) body.spans = spans;

  const res = await pushReceipt(parsed, body);
  if (!res.ok) {
    const message = `push failed (${res.status}) — ${res.detail ?? ''}`;
    if (opts.strict) throw new CliError(message, ExitCode.ERROR);
    info(c.yellow(`  ${message}`));
    return;
  }
  if (!quiet) info(c.green('✔') + ` receipt pushed to ${res.host}`);
}

/**
 * Write the committed agent memory. Kept separate from the receipt path because
 * this file is for humans and agents to read and commit, while the receipt is a
 * machine artifact — different audiences, different lifetimes.
 */
function writeAgentContext(result: RunReviewResult, opts: ReviewOpts, quiet: boolean): void {
  const input = {
    receipt: result.receipt,
    votes: result.votes,
    declaredTarget: result.intent.target,
    intentSources: result.intent.sources,
  };

  if (opts.writeContext) {
    const written = writeContextFile(result.repoRoot, input);
    if (!quiet) info(c.dim(`  agent context written to ${written}`));
  }

  if (opts.injectContext) {
    const target = typeof opts.injectContext === 'string' ? opts.injectContext : 'CLAUDE.md';
    const abs = path.resolve(result.repoRoot, target);
    // Only the managed block is ever rewritten, so instructions a human wrote
    // in the same file survive regeneration untouched.
    const existing = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
    fs.writeFileSync(abs, injectContextBlock(existing, renderContext(input)), 'utf8');
    if (!quiet) info(c.dim(`  managed review block updated in ${target}`));
  }
}
