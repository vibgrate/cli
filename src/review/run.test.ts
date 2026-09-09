import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CliError, ExitCode } from '../util/exit.js';
import { VERSION } from '../version.js';
import type { GitRunner } from './git.js';
import { repoKey } from './git.js';
import { runReview } from './run.js';
import {
  CAPSULE_SCHEMA,
  FINDINGS_SCHEMA,
  RECEIPT_SCHEMA,
  REVIEW_POLICY_VERSION,
  digest,
  receiptDigest,
} from './schemas.js';
import type { VgGraph } from '../schema.js';
import { edge, graph, node } from './test-fixtures.js';

// ── fixtures ────────────────────────────────────────────────────────────────

const HEAD = 'b'.repeat(40);
const BASE = 'a'.repeat(40);
const AT = '2026-08-27T10:00:00.000Z';

/** A temp repository root with the given files written to disk. */
function repo(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-review-run-'));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}

/** Write a code map as JSON and return its path, for `--graph`. */
function mapFile(root: string, g: VgGraph): string {
  const file = path.join(root, 'map', 'graph.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(g));
  return file;
}

interface GitAnswers {
  /** `git status --porcelain -uall` output (working-tree mode). */
  status?: string;
  /** `git diff --numstat` output. */
  numstat?: string;
  /** `git diff --name-status` output (base mode). */
  nameStatus?: string;
  /** `git diff -U3` output — the source of removed lines. */
  diff?: string;
  remote?: string;
  isRepo?: boolean;
  /** Every call, for assertions on what the pipeline asked git. */
  calls?: string[][];
}

/** An in-memory git: answers the plumbing `runReview` asks, nothing else. */
function fakeGit(root: string, a: GitAnswers = {}): GitRunner {
  const ok = (stdout: string) => ({ stdout, status: 0 });
  const fail = () => ({ stdout: '', status: 1 });
  return (args) => {
    a.calls?.push(args);
    const key = args.join(' ');
    if (key === 'rev-parse --git-dir') return a.isRepo === false ? fail() : ok('.git');
    if (key === 'rev-parse --show-toplevel') return ok(root);
    if (key === 'rev-parse HEAD') return ok(HEAD);
    if (key === 'rev-parse --abbrev-ref HEAD') return ok('main');
    if (key === 'config --get remote.origin.url') return a.remote ? ok(a.remote) : fail();
    if (key.startsWith('merge-base')) return ok(BASE);
    if (key.startsWith('status --porcelain')) return ok(a.status ?? '');
    if (key.startsWith('diff --numstat')) return ok(a.numstat ?? '');
    if (key.startsWith('diff --name-status')) return ok(a.nameStatus ?? '');
    if (key.startsWith('diff -U3')) return ok(a.diff ?? '');
    if (key.startsWith('diff -U0')) return ok('');
    return fail(); // `show`, `log`: nothing committed, nothing readable
  };
}

/** One changed route file, present in the map, no findings on its own. */
const ROUTE = 'src/routes/invoices.ts';
const ROUTE_TEXT = "import { listInvoices } from '../services/invoices.js';\nexport const list = (req) => listInvoices(req.user);\n";

function routeRepo() {
  const root = repo({ [ROUTE]: ROUTE_TEXT, 'src/services/invoices.ts': 'export const listInvoices = () => [];\n' });
  const g = graph([node('r', ROUTE), node('s', 'src/services/invoices.ts')], [edge('import', 'r', 's')]);
  return { root, graphPath: mapFile(root, g) };
}

const modified = (p: string) => ({ status: ` M ${p}\n`, numstat: `3\t1\t${p}\n` });

async function review(root: string, graphPath: string, answers: GitAnswers = {}, extra: Parameters<typeof runReview>[0] extends infer O ? Partial<O> : never = {}) {
  return runReview({ root, graphPath, generatedAt: AT, run: fakeGit(root, answers), ...extra });
}

// ── preconditions (spec §3) ─────────────────────────────────────────────────

describe('runReview — preconditions', () => {
  it('refuses a directory that is not a git repository with a usage error', async () => {
    const { root, graphPath } = routeRepo();
    await expect(review(root, graphPath, { isRepo: false })).rejects.toMatchObject({
      code: ExitCode.USAGE_ERROR,
      message: expect.stringContaining('needs a git repository'),
    });
  });

  it('exits 6 rather than passing when there is no code map', async () => {
    const root = repo({ [ROUTE]: ROUTE_TEXT });
    const missing = path.join(root, 'nowhere', 'graph.json');
    const err = await review(root, missing, modified(ROUTE)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe(ExitCode.ENGINE_UNAVAILABLE);
    expect((err as CliError).message).toContain('no code map found');
    expect((err as CliError).message).toContain(missing);
  });
});

// ── the quick path (changeClassOf) ──────────────────────────────────────────

describe('runReview — change class', () => {
  it('takes the quick path when every changed file is provably non-code', async () => {
    const { root, graphPath } = routeRepo();
    fs.writeFileSync(path.join(root, 'README.md'), '# hi\n');
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'docs/guide.md'), 'guide\n');
    const { receipt } = await review(root, graphPath, {
      status: ' M README.md\n M docs/guide.md\n M assets/logo.png\n',
      numstat: '1\t0\tREADME.md\n1\t0\tdocs/guide.md\n-\t-\tassets/logo.png\n',
    });
    expect(receipt.change_class).toEqual(['none']);
    expect(receipt.decision).toBe('pass');
    expect(receipt.quick_path).toBe(true);
    expect(receipt.counts).toEqual({ architecture: 0, security: 0, protected: 0, unknowns: 0 });
    expect(receipt.versions.model).toBe('none');
  });

  it('keeps a code file the classifier cannot place on the normal path — unknown is not absent', async () => {
    const { root, graphPath } = routeRepo();
    fs.writeFileSync(path.join(root, 'src/foo.ts'), 'export const x = 1;\n');
    const { receipt } = await review(root, graphPath, modified('src/foo.ts'));
    expect(receipt.change_class).toEqual(['architecture']);
    expect(receipt.quick_path).toBe(false);
  });

  it('classes a dependency manifest change as security, and never passes it unchecked', async () => {
    const { root, graphPath } = routeRepo();
    fs.writeFileSync(path.join(root, 'package.json'), '{ "dependencies": { "lodash": "4.17.20" } }\n');
    const { receipt, reasons } = await review(root, graphPath, modified('package.json'));
    expect(receipt.change_class).toEqual(['security']);
    expect(receipt.quick_path).toBe(false);
    expect(receipt.findings.required_checks).toEqual(['dependency-advisory-check']);
    expect(receipt.findings.unknowns.join(' ')).toContain('no advisory data was available');
    // No pattern could be established for a manifest-only change, so the
    // honest answer is undetermined — not a fake pass.
    expect(receipt.decision).toBe('undetermined');
    expect(reasons.join(' ')).toContain('unknown(s)');
  });

  it('classes a change with an added cross-layer edge as architecture', async () => {
    const root = repo({ [ROUTE]: "import { db } from '../repositories/db.js';\n", 'src/repositories/db.ts': 'export const db = {};\n' });
    const graphPath = mapFile(root, graph([node('r', ROUTE), node('d', 'src/repositories/db.ts')], [edge('import', 'r', 'd')]));
    const { receipt, capsule } = await review(root, graphPath, { status: `?? ${ROUTE}\n`, numstat: `1\t0\t${ROUTE}\n` });
    expect(capsule.change.added_edges).toHaveLength(1);
    expect(receipt.change_class).toContain('architecture');
  });
});

// ── scanner wiring, end to end ──────────────────────────────────────────────

describe('runReview — pipeline wiring', () => {
  it('fails on a known-vulnerable dependency read from the scan artifact on disk', async () => {
    const { root, graphPath } = routeRepo();
    fs.writeFileSync(path.join(root, 'package.json'), '{ "dependencies": { "lodash": "4.17.20" } }\n');
    fs.mkdirSync(path.join(root, '.vibgrate'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.vibgrate/scan_result.json'),
      JSON.stringify({ findings: [{ ruleId: 'vibgrate/vulnerability', message: 'CVE-2021-23337', location: 'package.json', details: { package: 'lodash' } }] }),
    );
    const { receipt } = await review(root, graphPath, modified('package.json'));
    expect(receipt.decision).toBe('fail');
    expect(receipt.findings.security_findings.map((f) => f.kind)).toEqual(['known_vulnerable_dependency']);
    expect(receipt.counts).toMatchObject({ security: 1, protected: 1 });
    expect(receipt.verification).toEqual({ protected_false_bless: false, schema_valid: true, evidence_ids_valid: true });
  });

  it('fails when the diff removed a guard that the file on disk no longer has', async () => {
    const { root, graphPath } = routeRepo();
    const diff = ['--- a/' + ROUTE, '+++ b/' + ROUTE, '@@ -1,3 +1,2 @@', '-  requireAuth(req)', '   return list(req)'].join('\n');
    const { receipt } = await review(root, graphPath, { ...modified(ROUTE), diff });
    const [sec] = receipt.findings.security_findings;
    expect(sec).toMatchObject({ kind: 'guard_removed', protected_finding: true, paths: [ROUTE] });
    expect(receipt.decision).toBe('fail');
    // The diff text itself never reaches the receipt.
    expect(JSON.stringify(receipt)).not.toContain('requireAuth(req)');
  });

  it('votes a changed open route against the unchanged route files the map knows about', async () => {
    const guarded = "router.post('/x', requireAuth, handler)\n";
    const files: Record<string, string> = { 'src/routes/admin.ts': "router.delete('/purge', purgeEverything)\n" };
    const nodes = [node('admin', 'src/routes/admin.ts')];
    for (let i = 0; i < 4; i++) {
      files[`src/routes/peer${i}.ts`] = guarded;
      nodes.push(node(`p${i}`, `src/routes/peer${i}.ts`));
    }
    const root = repo(files);
    const graphPath = mapFile(root, graph(nodes));
    const { receipt } = await review(root, graphPath, { status: '?? src/routes/admin.ts\n', numstat: '1\t0\tsrc/routes/admin.ts\n' });
    const [sec] = receipt.findings.security_findings;
    expect(sec).toMatchObject({ kind: 'unguarded_entrypoint', protected_finding: true, paths: ['src/routes/admin.ts'] });
    expect(sec.claim).toContain('DELETE /purge');
    expect(receipt.findings.required_checks).toContain('authz-test');
    expect(receipt.decision).toBe('fail');
  });

  it('indexes the map\'s function bodies and reports a changed re-implementation', async () => {
    const original = [
      'export function calculateInvoiceTotal(items, taxRate) {',
      '  let total = 0;',
      '  for (const item of items) {',
      '    total = total + item.price * item.quantity;',
      '  }',
      '  const tax = total * taxRate;',
      '  return round(total + tax, 2);',
      '}',
    ];
    const copy = original.map((l) => l.replace('calculateInvoiceTotal', 'computeBillSum'));
    const root = repo({ 'src/billing.ts': original.join('\n') + '\n', 'src/orders.ts': copy.join('\n') + '\n' });
    const g = graph([
      node('calc', 'src/billing.ts', { name: 'calculateInvoiceTotal', span: { start: 1, end: 8 } }),
      node('copy', 'src/orders.ts', { name: 'computeBillSum', span: { start: 1, end: 8 } }),
    ]);
    const { receipt } = await review(root, mapFile(root, g), { status: '?? src/orders.ts\n', numstat: '8\t0\tsrc/orders.ts\n' });
    const dup = receipt.findings.architecture_findings.find((f) => f.kind === 'duplicate_implementation');
    expect(dup).toBeDefined();
    expect(dup!.claim).toContain('computeBillSum in src/orders.ts');
    expect(dup!.claim).toContain('calculateInvoiceTotal in src/billing.ts:1');
  });

  it('reads the declared intent and the working-tree policy from the repository root', async () => {
    const { root, graphPath } = routeRepo();
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# Rules\n\nWe use a layered architecture.\n');
    fs.mkdirSync(path.join(root, '.vibgrate'), { recursive: true });
    fs.writeFileSync(path.join(root, '.vibgrate/review.toml'), '[review]\nenforcement = "enforced"\nfail_on = "needs_review"\n');
    const result = await review(root, graphPath, modified(ROUTE));
    expect(result.intent).toEqual({ target: 'layered', sources: ['CLAUDE.md'] });
    expect(result.capsule.patterns.declared_target_pattern).toBe('layered');
    expect(result.config.source).toBe('working-tree');
    expect(result.receipt.enforcement).toBe('enforced');
    expect(result.capsule.evidence).toContainEqual(expect.objectContaining({ id: 'intent:CLAUDE.md:3' }));
  });

  it('runs the explain layer only when asked, through the injected implementation', async () => {
    const { root, graphPath } = routeRepo();
    const explainImpl = async (_capsule: unknown, findings: import('./schemas.js').ReviewFindings) => ({
      findings: { ...findings, unknowns: [...findings.unknowns, 'The model could not see the audit path.'] },
      model: 'stub-coder-7b',
      quantization: 'Q4_K_M',
    });
    const plain = await review(root, graphPath, modified(ROUTE), { explainImpl });
    expect(plain.receipt.versions.model).toBe('none');

    const explained = await review(root, graphPath, modified(ROUTE), { explain: true, explainImpl });
    expect(explained.receipt.versions).toMatchObject({ model: 'stub-coder-7b', quantization: 'Q4_K_M' });
    expect(explained.receipt.findings.unknowns).toContain('The model could not see the audit path.');
    expect(explained.receipt.counts.unknowns).toBe(explained.receipt.findings.unknowns.length);
  });
});

// ── receipt construction ────────────────────────────────────────────────────

describe('runReview — receipt', () => {
  it('assembles the receipt from the change set, policy, and digests', async () => {
    const { root, graphPath } = routeRepo();
    const result = await review(root, graphPath, { ...modified(ROUTE), remote: 'https://user:ghp_secret@github.com/acme/ledger.git' }, { workspaceId: 'ws_1' });
    const { receipt, capsule } = result;

    expect(receipt.schema_version).toBe(RECEIPT_SCHEMA);
    expect(receipt.receipt_id).toMatch(/^rvw_[0-9A-HJKMNP-TV-Z]+$/);
    expect(receipt.created_at).toBe(AT);
    expect(receipt.workspace_id).toBe('ws_1');
    expect(receipt.repo).toEqual({ name: 'acme/ledger', remote: 'github.com/acme/ledger', repo_key: repoKey('github.com/acme/ledger', root) });
    expect(receipt.git).toEqual({ base_sha: HEAD, head_sha: HEAD, merge_base: null, ref: 'refs/heads/main', dirty: true, dirty_tree_hash: expect.stringMatching(/^sha256:/) });
    expect(receipt.enforcement).toBe('advisory');
    expect(receipt.findings.schema_version).toBe(FINDINGS_SCHEMA);
    expect(receipt.versions).toEqual({
      cli: VERSION,
      graph_schema: 'vg-graph/1.1',
      policy: REVIEW_POLICY_VERSION,
      model: 'none',
      quantization: null,
      capsule_schema: CAPSULE_SCHEMA,
    });
    expect(receipt.digests.capsule).toBe(digest(capsule));
    expect(receipt.digests.findings).toBe(digest(receipt.findings));
    expect(receipt.digests.evidence).toBe(digest(capsule.evidence));
    expect(receipt.digests.receipt).toBe(receiptDigest(receipt));
    expect(receipt.signature).toBeNull();
    expect(receipt.counts.unknowns).toBe(receipt.findings.unknowns.length);
    expect(result.repoRoot).toBe(root);
    expect(result.budget.cap).toBe(16_000);
    // The credential in the remote URL never reaches the receipt.
    expect(JSON.stringify(receipt)).not.toContain('ghp_secret');
  });

  it('names the repository after its directory when there is no remote', async () => {
    const { root, graphPath } = routeRepo();
    const { receipt } = await review(root, graphPath, modified(ROUTE));
    expect(receipt.repo).toMatchObject({ name: path.basename(root), remote: null });
    expect(receipt.workspace_id).toBeNull();
  });

  it('is byte-identical for the same tree and --generated-at, and re-keyed for a different one', async () => {
    const { root, graphPath } = routeRepo();
    const first = await review(root, graphPath, modified(ROUTE));
    const second = await review(root, graphPath, modified(ROUTE));
    expect(JSON.stringify(second.receipt)).toBe(JSON.stringify(first.receipt));

    const later = await runReview({ root, graphPath, generatedAt: '2026-08-28T10:00:00.000Z', run: fakeGit(root, modified(ROUTE)) });
    expect(later.receipt.created_at).toBe('2026-08-28T10:00:00.000Z');
    expect(later.receipt.receipt_id).not.toBe(first.receipt.receipt_id);
    expect(later.receipt.digests.receipt).not.toBe(first.receipt.digests.receipt);
    // Only the timestamp moved: the facts and the findings digest the same.
    expect(later.receipt.digests.capsule).toBe(first.receipt.digests.capsule);
    expect(later.receipt.digests.findings).toBe(first.receipt.digests.findings);
  });

  it('stamps the wall clock when --generated-at is not given', async () => {
    const { root, graphPath } = routeRepo();
    const before = Date.now();
    const { receipt } = await runReview({ root, graphPath, run: fakeGit(root, modified(ROUTE)) });
    expect(Date.parse(receipt.created_at)).toBeGreaterThanOrEqual(before - 1);
    expect(Date.parse(receipt.created_at)).toBeLessThanOrEqual(Date.now() + 1);
  });

  it('in --base mode reviews merge-base..HEAD with the wide capsule profile', async () => {
    const { root, graphPath } = routeRepo();
    const calls: string[][] = [];
    const result = await review(root, graphPath, { nameStatus: `M\t${ROUTE}\n`, numstat: `3\t1\t${ROUTE}\n`, calls }, { base: 'origin/main' });
    expect(result.receipt.git).toMatchObject({ base_sha: BASE, head_sha: HEAD, merge_base: BASE, dirty: false, dirty_tree_hash: null });
    expect(result.capsule.identity.profile).toBe('ci-wide');
    expect(result.budget.median).toBe(10_000);
    expect(calls).toContainEqual(['diff', '-U3', '-M', `${BASE}..HEAD`]);
    expect(calls).toContainEqual(['show', `origin/main:.vibgrate/review.toml`]);
  });
});
