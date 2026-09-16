/**
 * `vg review` — Vibgrate Review: architecture-aware change review that runs
 * locally (spec §3).
 *
 *   vg review                    changed-only vs HEAD (dirty tree + index)
 *   vg review --in-place         same as the default — working tree, explicit
 *   vg review --local            deterministic scanners; no hosted model
 *   vg review --loop             review → deterministic patch → re-review (CLI only)
 *   vg review --base origin/main merge-base of HEAD and base
 *   vg review explain <id>       the evidence behind one finding
 *   vg review propose <id>       PatchIR dry-run via the VG Code loop (`--apply --yes` to write)
 *   vg review verify <receipt>   check a receipt's digest and Ed25519 signature offline
 *
 * Exit codes are the CI contract and never conflate "missing" with "pass".
 * Gating is opt-in (like `vg scan`): without `--fail-on` or
 * `enforcement = "enforced"` the decision is reported and the process exits 0.
 * With a gate:
 *
 *   0  pass (or a decision the gate does not cover)
 *   2  fail — and, with `--fail-on needs_review`, needs_review / undetermined
 *      (`ExitCode.GATE_FAILED`; `1` is reserved for runtime errors — see policy.ts)
 *   6  missing graph, policy, or a required model
 *
 * `vg review verify` mirrors `vg evidence verify`: 0 verified, 2 unverified
 * (intact but the signer is not pinned, or the receipt is unsigned), 1 failed.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { KeyObject } from 'node:crypto';
import type { Command } from 'commander';
import { applyGlobalOptions, readGlobal } from '../cli-options.js';
import { CliError, ExitCode } from '../util/exit.js';
import { c, info, out } from '../util/output.js';
import { rootOf } from './util.js';
import { formatExplain, formatMarkdown, formatSarif, formatText, type ReviewFormat } from '../review/format.js';
import { exitCodeForDecision, resolveFailOn, FAIL_ON_LEVELS, type FailOnLevel } from '../review/policy.js';
import { buildEnvelope, collectSpans, pushReceipt, rejectPushWhenOffline, type ReviewPushBody } from '../review/push.js';
import { applyPatches, collectLoopPatches, loopNote, REVIEW_LOOP_MAX } from '../review/loop.js';
import { loadGraph } from '../engine/load.js';
import { proposeFindingFix, REVIEW_PROPOSE_LOOP_CAP } from '../review/propose.js';
import { runReview, type RunReviewResult } from '../review/run.js';
import { resolveReviewSigningKey, verifyReceipt } from '../review/sign.js';
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
  /** `--no-sign`; commander sets this false. */
  sign?: boolean;
  /** `--sign-key <file>` — Ed25519 private key PEM. */
  signKey?: string;
  /** `--in-place` — review the working tree (default without --base). */
  inPlace?: boolean;
  /** `--loop` — explicit review → patch → re-review. Never automatic. */
  loop?: boolean;
}

const FORMATS: ReviewFormat[] = ['text', 'json', 'sarif', 'md'];

export function registerReview(program: Command): void {
  const cmd = program
    .command('review')
    .description('Vibgrate Review — architecture + security-control review of the current change, locally')
    .option('--base <ref>', 'review HEAD against the merge-base with <ref> (e.g. origin/main)')
    .option(
      '--in-place',
      'review the working tree as-is (the default without --base; with --base, include uncommitted work against the merge-base)',
    )
    .option(
      '--loop',
      'repeat review → apply deterministic patches → re-review on this machine only. Never automatic. Does not write a hosted branch.',
    )
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
    .option(
      '--sign-key <file>',
      'Ed25519 private key PEM to sign the receipt with (default: $VG_ATTEST_KEY, else .vibgrate/attest-key.pem, minted on first use — the key `vg build --attest` and `vg evidence` share)',
    )
    .option('--no-sign', 'leave the receipt unsigned (signature: null)')
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

      const signingKey = resolveSigning(root, opts, Boolean(global.quiet));

      if (opts.loop && opts.base && !opts.inPlace) {
        throw new CliError(
          '`--loop` applies deterministic patches to the working tree — pass `--in-place` or omit `--base`',
          ExitCode.USAGE_ERROR,
        );
      }

      let result = await runReview({
        root,
        base: opts.base,
        inPlace: opts.inPlace,
        local: global.local,
        explain: opts.explain,
        offline: global.offline,
        graphPath: global.graph,
        generatedAt: global.generatedAt,
        signingKey,
      });

      if (opts.loop) {
        result = await runReviewLoop({
          root,
          opts,
          global,
          signingKey,
          first: result,
          quiet: Boolean(global.quiet) || Boolean(global.json),
        });
      }

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
        local: global.local,
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

  const verify = cmd
    .command('verify')
    .description('verify a receipt offline — its content digest and its Ed25519 signature (no Vibgrate needed)')
    .argument('<receipt>', 'a receipt written by `vg review --format json`')
    .option('--pub <file>', 'public key PEM to pin the signer (moves `unverified` to `verified`)')
    .action(function (this: Command, receiptPath: string, opts: { pub?: string }) {
      const global = readGlobal(this);
      const abs = path.resolve(receiptPath);
      if (!fs.existsSync(abs)) {
        throw new CliError(`no receipt at ${receiptPath} — write one with \`vg review --format json --out ${receiptPath}\``, ExitCode.NOT_FOUND);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(fs.readFileSync(abs, 'utf8'));
      } catch {
        throw new CliError(`${receiptPath} is not valid JSON — expected a vg.review.receipt.v1 document`, ExitCode.USAGE_ERROR);
      }
      let publicKeyPem: string | undefined;
      if (opts.pub) {
        const pubPath = path.resolve(opts.pub);
        if (!fs.existsSync(pubPath)) throw new CliError(`public key not found: ${opts.pub}`, ExitCode.USAGE_ERROR);
        publicKeyPem = fs.readFileSync(pubPath, 'utf8');
      }

      const v = verifyReceipt(parsed, { publicKeyPem });
      if (global.json) {
        out(JSON.stringify(v, null, 2));
      } else {
        const color = v.status === 'verified' ? c.green : v.status === 'failed' ? c.red : c.yellow;
        info(`  ${color(v.status.toUpperCase())}  ${v.reason}`);
        if (v.receiptId) {
          info(c.dim(`  receipt ${v.receiptId} · decision ${v.decision ?? '?'} · ${v.headSha ? v.headSha.slice(0, 8) : 'no head'} · ${v.keyid ? `key ${v.keyid}` : 'no key'}`));
        }
      }
      process.exitCode = v.status === 'verified' ? ExitCode.OK : v.status === 'unverified' ? ExitCode.GATE_FAILED : ExitCode.ERROR;
    });
  applyGlobalOptions(verify);

  const propose = cmd
    .command('propose')
    .description(
      `propose a PatchIR fix for one finding via the VG Code agent loop (dry-run; never writes the default branch)`,
    )
    .argument('<finding-id>', 'a finding id from the current change (e.g. arch-01)')
    .option('--base <ref>', 'review HEAD against the merge-base with <ref>')
    .option('--model <id>', 'relay:<slug> (hosted Review) or spark|flow|forge (local Code Mode); a bare slug is invalid')
    .option('--loop', `use the VG Code agent loop (cap ${REVIEW_PROPOSE_LOOP_CAP}; stops on no progress)`, true)
    .option('--single', 'one-shot residual → patch → verify instead of the agent loop')
    .option('--apply', 'write the patch (still requires --yes; refused on the default branch)')
    .option('--yes', 'consent to write when --apply is set')
    .action(async function (
      this: Command,
      findingId: string,
      opts: { base?: string; model?: string; loop?: boolean; single?: boolean; apply?: boolean; yes?: boolean },
    ) {
      const global = readGlobal(this);
      const root = rootOf(global);
      if (!opts.model) {
        throw new CliError(
          '`vg review propose` needs --model relay:<slug> (hosted) or spark|flow|forge (local Code Mode)',
          ExitCode.USAGE_ERROR,
        );
      }
      reportPrepare(
        await ensureCodeMap({
          root,
          graphPath: global.graph,
          quiet: Boolean(global.quiet) || Boolean(global.json),
        }),
        Boolean(global.quiet) || Boolean(global.json),
      );
      const reviewed = await runReview({
        root,
        base: opts.base,
        offline: global.offline,
        graphPath: global.graph,
        generatedAt: global.generatedAt,
        signingKey: null,
      });
      const all = [
        ...reviewed.receipt.findings.architecture_findings,
        ...reviewed.receipt.findings.security_findings,
      ];
      const hit = all.find((f) => f.id === findingId);
      if (!hit) {
        throw new CliError(
          `no finding "${findingId}" in this change set — run \`vg review\` to list the current findings`,
          ExitCode.NOT_FOUND,
        );
      }
      const graph = loadGraph(root, global.graph);
      if (!graph) {
        throw new CliError(
          'code map missing — run `vg` (or drop `--no-auto-build`) so Review can ground the proposal',
          ExitCode.ENGINE_UNAVAILABLE,
        );
      }
      const policySnippet = [
        ...reviewed.capsule.policies.map((p) => `${p.id}: ${p.rule}`),
        hit.remediation,
      ]
        .filter(Boolean)
        .join('\n');
      const result = await proposeFindingFix({
        capsule: reviewed.capsule,
        finding: hit,
        policySnippet,
        modelId: opts.model,
        root,
        graph,
        apply: !!opts.apply,
        consent: !!opts.yes,
        loop: opts.single ? false : opts.loop !== false,
        correlationId: `rp-${findingId}`,
      });
      if (global.json) {
        out(JSON.stringify(result, null, 2));
      } else if (!global.quiet) {
        const tag = result.ok ? c.green('PROPOSED') : c.red('NOT APPLIED');
        info(`  ${tag}  ${result.stopReason}  ${hit.id}  (ref ${result.correlationId})`);
        if (result.error) info(c.dim(`  ${result.error}`));
        if (result.proposedDiff) info(result.proposedDiff);
        else if (result.finalText) info(c.dim(`  ${result.finalText}`));
        if (!result.applied) {
          info(c.dim('  dry-run — re-run with --apply --yes on a topic branch to write'));
        }
      }
      if (!result.ok) process.exitCode = ExitCode.ERROR;
    });
  applyGlobalOptions(propose);
}

/**
 * The signing key for this run, or `null` under `--no-sign`. Resolution is the
 * one Vibgrate Evidence uses (explicit → `$VG_ATTEST_KEY` → `.vibgrate/attest-key.pem`),
 * and a first-use mint is said out loud: the key must be kept and gitignored
 * for the signature to stay reproducible and pinnable.
 */
function resolveSigning(root: string, opts: ReviewOpts, quiet: boolean): KeyObject | null {
  if (opts.sign === false) return null;
  const { key, keyPath, minted } = resolveReviewSigningKey(root, opts.signKey);
  if (minted && !quiet) {
    info(
      c.yellow(`  minted a new Ed25519 signing key at ${path.relative(root, keyPath) || keyPath}`)
        + c.dim(' — keep it, gitignore it, and reuse it (or set VG_ATTEST_KEY) so receipts stay reproducible and pinnable'),
    );
  }
  return key;
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

async function runReviewLoop(params: {
  root: string;
  opts: ReviewOpts;
  global: ReturnType<typeof readGlobal>;
  signingKey: KeyObject | null;
  first: RunReviewResult;
  quiet: boolean;
}): Promise<RunReviewResult> {
  let result = params.first;
  for (let iteration = 1; iteration <= REVIEW_LOOP_MAX; iteration += 1) {
    const patches = collectLoopPatches(result.repoRoot, result);
    const applied = applyPatches(result.repoRoot, patches);
    if (!params.quiet) info(c.dim(`  ${loopNote(applied, iteration)}`));
    if (applied.length === 0) return result;
    result = await runReview({
      root: params.root,
      base: params.opts.base,
      inPlace: true,
      local: params.global.local,
      explain: params.opts.explain,
      offline: params.global.offline,
      graphPath: params.global.graph,
      generatedAt: params.global.generatedAt,
      signingKey: params.signingKey,
    });
  }
  if (!params.quiet) {
    info(c.dim(`  --loop stopped after ${REVIEW_LOOP_MAX} iterations. Remaining findings need a human.`));
  }
  return result;
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
