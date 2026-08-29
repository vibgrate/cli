/**
 * `vg review` — the pipeline (spec §1):
 *
 *   source + diff
 *     → Vibgrate Graph + deterministic scanners
 *     → Analysis Capsule
 *     → optional local model (findings only)
 *     → schema verifier
 *     → signed policy
 *     → vg.review.receipt.v1
 *
 * Each stage owns exactly one thing. This module is the wiring, and it is the
 * only place where a receipt is constructed — `decision` is written once, from
 * the policy result, and never anywhere else.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { classifyFile } from '../core-open/scanners/architecture/classify.js';
import { loadGraph } from '../engine/load.js';
import { VERSION } from '../version.js';
import { CliError, ExitCode } from '../util/exit.js';
import { compileCapsule, repoPseudonym } from './capsule.js';
import { loadReviewConfig, type ReviewConfig } from './config.js';
import {
  collectChangeSet,
  fileRecencyDays,
  isGitRepo,
  readBaseFileTexts,
  repoKey,
  type ChangeSet,
  type GitRunner,
} from './git.js';
import { readDeclaredIntent } from './intent.js';
import type { DominanceVote } from './dominance.js';
import { applyReviewPolicy } from './policy.js';
import { removedLinesFromDiff, runScanners, vulnerablePackagesFromScan } from './scanners.js';
import { isComparable, SimilarityIndex, type FunctionBody } from './similarity.js';
import {
  CAPSULE_SCHEMA,
  FINDINGS_SCHEMA,
  RECEIPT_SCHEMA,
  REVIEW_POLICY_VERSION,
  digest,
  receiptDigest,
  receiptId,
  type AnalysisCapsule,
  type CapsuleProfile,
  type ChangeClass,
  type ReviewFindings,
  type ReviewReceipt,
} from './schemas.js';
import { verifyFindings, type VerifyResult } from './verify.js';

export interface RunReviewOptions {
  root: string;
  /** `--base <ref>`; omitted reviews the working tree + index against HEAD. */
  base?: string;
  /** `--explain` — requires a local model, else fails closed with exit 6. */
  explain?: boolean;
  /** `--offline` — never touch the network (also true under `--local`). */
  offline?: boolean;
  /** `--graph <file>` override. */
  graphPath?: string;
  /** `--generated-at <iso>` — pins `created_at` for byte-deterministic output. */
  generatedAt?: string;
  workspaceId?: string | null;
  /** Injected in tests. */
  run?: GitRunner;
  /** Injected in tests so the explain path does not need a real model. */
  explainImpl?: typeof import('./explain.js').explainFindings;
}

export interface RunReviewResult {
  receipt: ReviewReceipt;
  capsule: AnalysisCapsule;
  config: ReviewConfig;
  verification: VerifyResult;
  /** Why policy decided what it decided — rendered by the text/markdown output. */
  reasons: string[];
  /** Capsule budget telemetry for the human report. */
  budget: { estimatedTokens: number; median: number; cap: number; trimmed: boolean };
  /** Peer votes, for the context file and `assess_change`. */
  votes: DominanceVote[];
  /** What the repository declared, and where. */
  intent: { target: string | null; sources: string[] };
  /** The resolved repository root — every path in the receipt is relative to it. */
  repoRoot: string;
}

function defaultRun(args: string[], cwd: string): { stdout: string; status: number } {
  const res = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 20_000,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  return { stdout: res.stdout ?? '', status: res.status ?? 1 };
}

/**
 * Files that carry no architectural surface: prose, images, and generated
 * artifacts. Kept deliberately narrow — anything not on this list counts as
 * code, because the quick path must be earned by positive evidence, never by
 * the analyzer failing to recognise a file.
 */
const NON_CODE = /\.(md|mdx|markdown|txt|rst|adoc|png|jpe?g|gif|svg|ico|webp|woff2?|ttf|eot|pdf|csv|snap|lock)$/i;
const NON_CODE_DIRS = /(^|\/)(docs?|\.github\/ISSUE_TEMPLATE|changelog|marketing)\//i;

/** Dependency manifests — non-code by extension, but security-relevant. */
const DEPENDENCY_MANIFEST =
  /(^|\/)(package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|.*\.csproj|packages\.lock\.json|Directory\.Packages\.props|requirements.*\.txt|pyproject\.toml|poetry\.lock|go\.mod|go\.sum|Cargo\.toml|Cargo\.lock|pom\.xml|build\.gradle(\.kts)?|Gemfile(\.lock)?|composer\.(json|lock))$/i;

const EXEMPT_LAYERS = new Set(['config', 'shared', 'testing']);

/**
 * Which domains this change set materially touches. `['none']` is the quick
 * path (spec §1) — policy passes without loading a model.
 *
 * The quick path is only taken when *every* changed file is provably outside
 * the architectural and security surface. A file the classifier could not place
 * is not evidence of "no delta"; it keeps the change on the normal path, where
 * the unknowns it carries land on `needs_review` / `undetermined` rather than a
 * fake pass.
 */
function changeClassOf(capsule: AnalysisCapsule, findings: { architecture: number; security: number }): ChangeClass[] {
  const classes: ChangeClass[] = [];
  const roleByPath = new Map(capsule.roles.filter((r) => r.changed).map((r) => [r.path, r]));

  const architecturalPaths = capsule.change.ops.filter((op) => {
    if (DEPENDENCY_MANIFEST.test(op.path)) return false; // counted under security
    if (NON_CODE.test(op.path) || NON_CODE_DIRS.test(op.path)) return false;
    const role = roleByPath.get(op.path);
    // Unclassified (`role === undefined`) counts as architectural: unknown is
    // not the same as absent.
    return role === undefined || !EXEMPT_LAYERS.has(role.layer);
  });

  if (findings.architecture > 0 || capsule.change.added_edges.length > 0 || architecturalPaths.length > 0) {
    classes.push('architecture');
  }
  const dependencyChanges = capsule.change.ops.filter((op) => DEPENDENCY_MANIFEST.test(op.path));
  if (findings.security > 0 || capsule.security.length > 0 || dependencyChanges.length > 0) {
    classes.push('security');
  }
  return classes.length > 0 ? classes : ['none'];
}

export async function runReview(opts: RunReviewOptions): Promise<RunReviewResult> {
  const root = path.resolve(opts.root);
  const run = opts.run ?? defaultRun;

  if (!isGitRepo(root, run)) {
    throw new CliError(
      `\`vg review\` needs a git repository — ${root} is not one (or git is not on PATH)`,
      ExitCode.USAGE_ERROR,
    );
  }

  const change: ChangeSet = collectChangeSet(root, opts.base, run);
  // git reports repo-relative paths, so every read below is anchored at the
  // repository root — not at whatever subdirectory `-C` pointed us to.
  const repoRoot = change.topLevel;
  const config = loadReviewConfig(repoRoot, opts.base, run);

  // Spec §3, exit 6: a missing graph is never treated as `pass`. Review reasons
  // from the code map — without one there is no edge, role, or test evidence to
  // reason over, and a decision made anyway would be a guess wearing a receipt.
  const graph = loadGraph(root, opts.graphPath);
  if (!graph) {
    throw new CliError(
      'no code map found — run `vg` in this repository first, then `vg review`'
        + (opts.graphPath ? ` (looked at ${opts.graphPath})` : ''),
      ExitCode.ENGINE_UNAVAILABLE,
    );
  }

  // Read once, before the capsule: recency drives the peer vote's temporal
  // weighting, and declared intent seeds it.
  const recencyDays = fileRecencyDays(repoRoot, {}, run);
  const intent = readDeclaredIntent(repoRoot);

  const changedPathSet = new Set(change.files.map((f) => f.path.replace(/\\/g, '/')));
  const fileText = new Map<string, string>();
  for (const file of change.files) {
    if (file.op === 'removed') continue;
    const abs = path.join(repoRoot, file.path);
    try {
      const stat = fs.statSync(abs);
      // Guard rail, not a policy: a multi-megabyte generated file is not worth
      // pattern-matching, and reading it would blow the interactive budget.
      if (stat.isFile() && stat.size <= 2 * 1024 * 1024) {
        fileText.set(file.path.replace(/\\/g, '/'), fs.readFileSync(abs, 'utf8'));
      }
    } catch {
      /* unreadable — treated as "not observed", never as "clean" */
    }
  }
  const baseFileText = readBaseFileTexts(change, run);

  const profile: CapsuleProfile = opts.base ? 'ci-wide' : 'interactive-narrow';
  const compiled = compileCapsule({
    root: repoRoot,
    graph,
    change,
    config,
    profile,
    repoPseudonym: repoPseudonym(change.remote, repoRoot),
    recencyDays,
    intent,
    baseFileText,
    headFileText: fileText,
  });
  const capsule = compiled.capsule;

  // Diff text is read once, here, and never leaves this process: the receipt
  // carries claims and spans, never source lines (spec §3, privacy flags).
  const diffArgs = opts.base ? ['diff', '-U3', '-M', `${change.baseSha}..HEAD`] : ['diff', '-U3', '-M', 'HEAD'];
  const removedLines = removedLinesFromDiff(run(diffArgs, repoRoot).stdout);

  // Peer route files: the wider entrypoint surface the auth vote needs. Bounded
  // to files the map already knows about and to the route-bearing layers, so
  // this never becomes a whole-repository read.
  const peerFileText = new Map<string, string>();
  const ROUTE_LAYERS = new Set(['routing', 'middleware', 'presentation']);
  for (const node of graph.nodes) {
    const rel = node.file.replace(/\\/g, '/');
    if (peerFileText.has(rel) || fileText.has(rel)) continue;
    if (peerFileText.size >= 300) break;
    const cls = classifyFile(rel, 'unknown');
    if (!cls || !ROUTE_LAYERS.has(cls.layer)) continue;
    try {
      const abs = path.join(repoRoot, rel);
      const stat = fs.statSync(abs);
      if (stat.isFile() && stat.size <= 512 * 1024) peerFileText.set(rel, fs.readFileSync(abs, 'utf8'));
    } catch {
      /* unreadable peer — simply not counted */
    }
  }

  // Similarity index over the repository's existing function bodies, plus the
  // bodies this change introduced. Built from the graph's own symbol spans, so
  // there is no second parse — `vg build` already located every function.
  const similarity = new SimilarityIndex();
  const changedBodies: FunctionBody[] = [];
  const FUNCTION_KINDS = new Set(['function', 'method']);
  const sourceCache = new Map<string, string[] | null>();
  const linesOf = (rel: string): string[] | null => {
    if (sourceCache.has(rel)) return sourceCache.get(rel)!;
    let value: string[] | null = null;
    try {
      const abs = path.join(repoRoot, rel);
      const stat = fs.statSync(abs);
      if (stat.isFile() && stat.size <= 1024 * 1024) value = fs.readFileSync(abs, 'utf8').split('\n');
    } catch {
      value = null;
    }
    sourceCache.set(rel, value);
    return value;
  };

  for (const node of graph.nodes) {
    if (!FUNCTION_KINDS.has(node.kind)) continue;
    const rel = node.file.replace(/\\/g, '/');
    if (!isComparable(rel)) continue;
    const lines = linesOf(rel);
    if (!lines) continue;
    const text = lines.slice(node.span.start - 1, node.span.end).join('\n');
    if (!text.trim()) continue;
    const body: FunctionBody = {
      id: node.id,
      name: node.name,
      file: rel,
      startLine: node.span.start,
      endLine: node.span.end,
      text,
    };
    // A changed body is the *query*, not part of the corpus it is compared
    // against — otherwise every changed function matches itself at 100%.
    if (changedPathSet.has(rel)) changedBodies.push(body);
    else similarity.add(body);
  }

  const scan = runScanners({
    root: repoRoot,
    capsule,
    change,
    config,
    removedLines,
    fileText,
    vulnerablePackages: vulnerablePackagesFromScan(repoRoot),
    votes: compiled.votes,
    peerFileText,
    similarity,
    changedBodies,
    dataAccess: compiled.dataAccess,
    changedPaths: changedPathSet,
  });

  let findings: ReviewFindings = {
    schema_version: FINDINGS_SCHEMA,
    change_class: changeClassOf(capsule, {
      architecture: scan.architecture.length,
      security: scan.security.length,
    }),
    architecture_findings: scan.architecture,
    security_findings: scan.security,
    unknowns: [...new Set([...compiled.unknowns, ...scan.unknowns])],
    required_checks: scan.requiredChecks,
  };

  let modelId = 'none';
  let quantization: string | null = null;
  if (opts.explain) {
    const explainImpl = opts.explainImpl ?? (await import('./explain.js')).explainFindings;
    const explained = await explainImpl(capsule, findings, { offline: opts.offline });
    findings = explained.findings;
    modelId = explained.model;
    quantization = explained.quantization;
  }

  // The verifier runs on whatever produced the findings — scanners included.
  const verification = verifyFindings(findings, capsule);
  const policy = applyReviewPolicy(capsule, findings, config, verification);

  const createdAt = opts.generatedAt ?? new Date().toISOString();
  const capsuleDigest = digest(capsule);
  const findingsDigest = digest(findings);
  const evidenceDigest = digest(capsule.evidence);

  const protectedCount = [...findings.architecture_findings, ...findings.security_findings].filter(
    (f) => f.protected_finding === true,
  ).length;

  const receipt: ReviewReceipt = {
    schema_version: RECEIPT_SCHEMA,
    receipt_id: receiptId(Date.parse(createdAt) || 0, `${capsuleDigest}${findingsDigest}`),
    created_at: createdAt,
    workspace_id: opts.workspaceId ?? null,
    repo: {
      name: change.remote ? change.remote.split('/').slice(-2).join('/') : path.basename(repoRoot),
      remote: change.remote,
      repo_key: repoKey(change.remote, repoRoot),
    },
    git: {
      base_sha: change.baseSha,
      head_sha: change.headSha,
      merge_base: change.mergeBase,
      ref: change.ref,
      dirty: change.dirty,
      dirty_tree_hash: change.dirtyTreeHash,
    },
    decision: policy.decision,
    enforcement: config.enforcement,
    quick_path: policy.quickPath,
    change_class: findings.change_class,
    counts: {
      architecture: findings.architecture_findings.length,
      security: findings.security_findings.length,
      protected: protectedCount,
      unknowns: findings.unknowns.length,
    },
    findings,
    versions: {
      cli: VERSION,
      graph_schema: graph?.schemaVersion ?? 'none',
      policy: REVIEW_POLICY_VERSION,
      model: modelId,
      quantization,
      capsule_schema: CAPSULE_SCHEMA,
    },
    digests: {
      capsule: capsuleDigest,
      findings: findingsDigest,
      evidence: evidenceDigest,
      receipt: '',
    },
    verification: {
      protected_false_bless: policy.protectedFalseBless,
      schema_valid: verification.schema_valid,
      evidence_ids_valid: verification.evidence_ids_valid,
    },
    signature: null,
  };
  receipt.digests.receipt = receiptDigest(receipt);

  return {
    receipt,
    capsule,
    config,
    verification,
    reasons: policy.reasons,
    votes: compiled.votes,
    intent: {
      target: capsule.patterns.declared_target_pattern,
      sources: intent.sources,
    },
    repoRoot,
    budget: {
      estimatedTokens: compiled.estimatedTokens,
      median: compiled.budget.median,
      cap: compiled.budget.cap,
      trimmed: compiled.trimmed,
    },
  };
}
