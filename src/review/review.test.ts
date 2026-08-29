import { describe, expect, it } from 'vitest';
import { parseReviewConfig, DEFAULT_REVIEW_CONFIG, loadReviewConfig, type ReviewConfig } from './config.js';
import {
  collectChangeSet,
  dirtyTreeHash,
  isReviewable,
  normalizeRemote,
  readBaseFileTexts,
  repoKey,
  type GitRunner,
} from './git.js';
import { rejectPushWhenOffline } from './push.js';
import { evaluateLayerSkip } from './layers.js';
import { applyReviewPolicy, exitCodeForDecision, resolveFailOn } from './policy.js';
import { CliError, ExitCode } from '../util/exit.js';
import { mergeExplanations, pickExplainModel } from './explain.js';
import { removedLinesFromDiff } from './scanners.js';
import {
  CAPSULE_SCHEMA,
  FINDINGS_SCHEMA,
  RECEIPT_SCHEMA,
  digest,
  findingFingerprint,
  receiptDigest,
  receiptId,
  type AnalysisCapsule,
  type ReviewFinding,
  type ReviewFindings,
  type ReviewReceipt,
} from './schemas.js';
import { verifyFindings } from './verify.js';

// ── fixtures ────────────────────────────────────────────────────────────────

function capsule(overrides: Partial<AnalysisCapsule> = {}): AnalysisCapsule {
  return {
    schema_version: CAPSULE_SCHEMA,
    identity: {
      repo_pseudonym: 'sha256:abc',
      language: 'typescript',
      graph_schema: 'vg-graph/1.1',
      analyzer_versions: { graph: '1', scanners: '1' },
      profile: 'interactive-narrow',
    },
    change: {
      base_sha: 'a'.repeat(40),
      head_sha: 'b'.repeat(40),
      dirty: false,
      dirty_tree_hash: null,
      symbols: [],
      ops: [],
      added_edges: [],
      removed_edges: [],
      contract_changes: [],
    },
    roles: [],
    areas: [],
    patterns: {
      observed_dominant_pattern: 'layered',
      declared_target_pattern: 'layered',
      approved_exceptions: [],
      legacy_pattern: null,
      unknown: false,
    },
    paths: [],
    security: [],
    policies: [],
    verification: [],
    evidence: [{ id: 'edge:1', kind: 'graph_edge', path: 'src/a.ts', protected_finding: false }],
    ...overrides,
  };
}

function finding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    id: 'arch-01',
    kind: 'boundary_bypass',
    severity: 'high',
    confidence: 0.95,
    claim: 'The new handler calls persistence directly.',
    evidence_ids: ['edge:1'],
    target_alignment: 'regression',
    remediation: 'Route through the application service.',
    paths: ['src/a.ts'],
    source: 'scanner',
    ...overrides,
  };
}

function findings(overrides: Partial<ReviewFindings> = {}): ReviewFindings {
  return {
    schema_version: FINDINGS_SCHEMA,
    change_class: ['architecture'],
    architecture_findings: [],
    security_findings: [],
    unknowns: [],
    required_checks: [],
    ...overrides,
  };
}

const config = (o: Partial<ReviewConfig> = {}): ReviewConfig => ({ ...DEFAULT_REVIEW_CONFIG, ...o });
const clean = { schema_valid: true, evidence_ids_valid: true, errors: [] };

// ── the protected-finding invariant ─────────────────────────────────────────

describe('protected-finding invariant', () => {
  it('fails when a protected finding is unresolved', () => {
    const f = findings({
      security_findings: [finding({ id: 'sec-01', kind: 'unguarded_entrypoint', protected_finding: true })],
    });
    expect(applyReviewPolicy(capsule(), f, config(), clean).decision).toBe('fail');
  });

  it('cannot be blessed by a target-aligned classification', () => {
    const f = findings({
      security_findings: [
        finding({ id: 'sec-01', kind: 'unguarded_entrypoint', protected_finding: true, target_alignment: 'target' }),
      ],
    });
    expect(applyReviewPolicy(capsule(), f, config(), clean).decision).toBe('fail');
  });

  it('cannot be blessed by an approved exception', () => {
    const f = findings({
      security_findings: [
        finding({
          id: 'sec-01',
          kind: 'known_vulnerable_dependency',
          protected_finding: true,
          target_alignment: 'approved_exception',
        }),
      ],
    });
    expect(applyReviewPolicy(capsule(), f, config(), clean).decision).toBe('fail');
  });

  it('cannot be blessed by a quick-path change class', () => {
    const f = findings({
      change_class: ['none'],
      security_findings: [finding({ id: 'sec-01', kind: 'validated_taint', protected_finding: true })],
    });
    const result = applyReviewPolicy(capsule(), f, config(), clean);
    expect(result.decision).toBe('fail');
    expect(result.quickPath).toBe(false);
  });

  it('cannot be blessed by low confidence', () => {
    const f = findings({
      security_findings: [
        finding({ id: 'sec-01', kind: 'unguarded_entrypoint', protected_finding: true, confidence: 0.01, severity: 'low' }),
      ],
    });
    expect(applyReviewPolicy(capsule(), f, config(), clean).decision).toBe('fail');
  });

  it('reports protected_false_bless as false — the invariant is never exercised', () => {
    const f = findings({
      security_findings: [finding({ id: 'sec-01', kind: 'unguarded_entrypoint', protected_finding: true })],
    });
    expect(applyReviewPolicy(capsule(), f, config(), clean).protectedFalseBless).toBe(false);
  });

  it('a disabled protected rule stops producing a protected fail', () => {
    const f = findings({
      security_findings: [finding({ id: 'sec-01', kind: 'known_vulnerable_dependency', protected_finding: true })],
    });
    const cfg = config({ protected: { ...DEFAULT_REVIEW_CONFIG.protected, known_vulnerable_dependency: false } });
    // Still not a pass — it is a high-severity finding — but not the protected branch.
    const result = applyReviewPolicy(capsule(), f, cfg, clean);
    expect(result.protectedCount).toBe(0);
    expect(result.decision).toBe('fail');
  });
});

// ── policy table (spec §5) ──────────────────────────────────────────────────

describe('apply_review_policy', () => {
  it('passes on the quick path with no material delta', () => {
    const result = applyReviewPolicy(capsule(), findings({ change_class: ['none'] }), config(), clean);
    expect(result.decision).toBe('pass');
    expect(result.quickPath).toBe(true);
  });

  it('passes when every finding is target-aligned', () => {
    const f = findings({ architecture_findings: [finding({ target_alignment: 'target' })] });
    expect(applyReviewPolicy(capsule(), f, config(), clean).decision).toBe('pass');
  });

  it('escalates a high-severity finding above the confidence threshold', () => {
    const f = findings({ architecture_findings: [finding({ confidence: 0.93 })] });
    expect(applyReviewPolicy(capsule(), f, config(), clean).decision).toBe('fail');
  });

  it('honours high_severity_decision = needs_review', () => {
    const f = findings({ architecture_findings: [finding({ confidence: 0.93 })] });
    const cfg = config({ high_severity_decision: 'needs_review' });
    expect(applyReviewPolicy(capsule(), f, cfg, clean).decision).toBe('needs_review');
  });

  it('leaves a low-confidence high finding at needs_review', () => {
    const f = findings({ architecture_findings: [finding({ confidence: 0.3 })] });
    expect(applyReviewPolicy(capsule(), f, config(), clean).decision).toBe('needs_review');
  });

  it('returns needs_review for medium-only findings', () => {
    const f = findings({ architecture_findings: [finding({ severity: 'medium', confidence: 0.7 })] });
    expect(applyReviewPolicy(capsule(), f, config(), clean).decision).toBe('needs_review');
  });

  it('returns undetermined for unknowns when the pattern could not be established', () => {
    const c = capsule({
      patterns: {
        observed_dominant_pattern: null,
        declared_target_pattern: null,
        approved_exceptions: [],
        legacy_pattern: null,
        unknown: true,
      },
    });
    const f = findings({ unknowns: ['No runtime authorization test was supplied.'] });
    expect(applyReviewPolicy(c, f, config(), clean).decision).toBe('undetermined');
  });

  it('returns needs_review for unknowns when the pattern is known', () => {
    const f = findings({ required_checks: ['authz-test'] });
    expect(applyReviewPolicy(capsule(), f, config(), clean).decision).toBe('needs_review');
  });

  it('returns undetermined when the findings document failed verification', () => {
    const f = findings({ architecture_findings: [finding()] });
    const bad = { schema_valid: false, evidence_ids_valid: true, errors: ['x'] };
    expect(applyReviewPolicy(capsule(), f, config(), bad).decision).toBe('undetermined');
  });

  it('never lets a verification failure become a pass', () => {
    const bad = { schema_valid: true, evidence_ids_valid: false, errors: ['invented evidence'] };
    expect(applyReviewPolicy(capsule(), findings({ change_class: ['none'] }), config(), bad).decision).toBe(
      'undetermined',
    );
  });
});

describe('exit codes', () => {
  it('never gates without an explicit gate — the `vg scan` contract', () => {
    // Gating is opt-in. A `fail` decision is reported and written to the
    // receipt, but it does not break a build nobody asked it to break.
    expect(exitCodeForDecision('pass', 'none')).toBe(0);
    expect(exitCodeForDecision('fail', 'none')).toBe(0);
    expect(exitCodeForDecision('needs_review', 'none')).toBe(0);
    expect(exitCodeForDecision('undetermined', 'none')).toBe(0);
  });

  it('gates `fail` at exit 2, the shared GATE_FAILED code', () => {
    expect(exitCodeForDecision('fail', 'fail')).toBe(2);
    expect(exitCodeForDecision('pass', 'fail')).toBe(0);
    // needs_review is not a fail at this gate level.
    expect(exitCodeForDecision('needs_review', 'fail')).toBe(0);
    expect(exitCodeForDecision('undetermined', 'fail')).toBe(0);
  });

  it('gates the unsure band too at needs_review', () => {
    expect(exitCodeForDecision('fail', 'needs_review')).toBe(2);
    expect(exitCodeForDecision('needs_review', 'needs_review')).toBe(2);
    expect(exitCodeForDecision('undetermined', 'needs_review')).toBe(2);
    expect(exitCodeForDecision('pass', 'needs_review')).toBe(0);
  });

  it('never exits 1 — that code means the command itself errored', () => {
    for (const gate of ['none', 'fail', 'needs_review'] as const) {
      for (const d of ['pass', 'fail', 'needs_review', 'undetermined'] as const) {
        expect(exitCodeForDecision(d, gate)).not.toBe(1);
      }
    }
  });
});

describe('resolveFailOn', () => {
  it('does not gate an advisory repository', () => {
    expect(resolveFailOn(undefined, { enforcement: 'advisory', fail_on: 'fail' })).toBe('none');
  });

  it('gates at the configured level once enforcement is on', () => {
    expect(resolveFailOn(undefined, { enforcement: 'enforced', fail_on: 'fail' })).toBe('fail');
    expect(resolveFailOn(undefined, { enforcement: 'enforced', fail_on: 'needs_review' })).toBe('needs_review');
  });

  it('lets an explicit flag override the config in both directions', () => {
    expect(resolveFailOn('needs_review', { enforcement: 'advisory', fail_on: 'fail' })).toBe('needs_review');
    expect(resolveFailOn('none', { enforcement: 'enforced', fail_on: 'fail' })).toBe('none');
  });
});

// ── the verifier (spec §4.2) ────────────────────────────────────────────────

describe('verifyFindings', () => {
  it('accepts a well-formed document', () => {
    const result = verifyFindings(findings({ architecture_findings: [finding()] }), capsule());
    expect(result.errors).toEqual([]);
    expect(result.schema_valid).toBe(true);
  });

  it('rejects a wrong schema version', () => {
    const bad = { ...findings(), schema_version: 'vg.review.findings.v2' } as unknown as ReviewFindings;
    expect(verifyFindings(bad, capsule()).schema_valid).toBe(false);
  });

  it('rejects an evidence id that is not in the capsule', () => {
    const f = findings({ architecture_findings: [finding({ evidence_ids: ['edge:9999'] })] });
    const result = verifyFindings(f, capsule());
    expect(result.evidence_ids_valid).toBe(false);
    expect(result.errors.join(' ')).toContain('not in the capsule');
  });

  it('rejects a claimed flow with no supporting fact', () => {
    const f = findings({ architecture_findings: [finding({ evidence_ids: [] })] });
    const result = verifyFindings(f, capsule());
    expect(result.evidence_ids_valid).toBe(false);
    expect(result.errors.join(' ')).toContain('no supporting graph or scanner fact');
  });

  it.each([
    ['The endpoint is secure.', 'secure'],
    ['There are no vulnerabilities in this change.', 'no vulnerability'],
    ['This path is safe.', 'safe'],
    ['The dependency is approved.', 'approved'],
  ])('rejects the absolute claim in %j', (claim, label) => {
    const f = findings({ architecture_findings: [finding({ claim })] });
    expect(verifyFindings(f, capsule()).errors.join(' ')).toContain(label);
  });

  it('rejects a runtime assertion with no stated uncertainty', () => {
    const f = findings({ architecture_findings: [finding({ claim: 'This will always throw at runtime.' })] });
    expect(verifyFindings(f, capsule()).errors.join(' ')).toContain('without stating the uncertainty');
  });

  it('accepts a hedged runtime observation', () => {
    const f = findings({
      architecture_findings: [finding({ claim: 'This may throw at runtime; nothing was executed.' })],
    });
    expect(verifyFindings(f, capsule()).errors).toEqual([]);
  });

  it('rejects a `decision` field wherever it came from', () => {
    const f = { ...findings(), decision: 'pass' } as unknown as ReviewFindings;
    expect(verifyFindings(f, capsule()).errors.join(' ')).toContain('only policy may decide');
  });

  it('rejects duplicate finding ids', () => {
    const f = findings({ architecture_findings: [finding(), finding()] });
    expect(verifyFindings(f, capsule()).errors.join(' ')).toContain('duplicate finding id');
  });

  it('rejects an out-of-range confidence', () => {
    const f = findings({ architecture_findings: [finding({ confidence: 1.5 })] });
    expect(verifyFindings(f, capsule()).errors.join(' ')).toContain('0..1');
  });

  it('rejects an invalid target_alignment', () => {
    const f = findings({
      architecture_findings: [finding({ target_alignment: 'fine' as ReviewFinding['target_alignment'] })],
    });
    expect(verifyFindings(f, capsule()).errors.join(' ')).toContain('target_alignment');
  });
});

// ── digests + lineage ───────────────────────────────────────────────────────

describe('digests', () => {
  it('is stable across key order', () => {
    expect(digest({ a: 1, b: 2 })).toBe(digest({ b: 2, a: 1 }));
  });

  it('changes when content changes', () => {
    expect(digest({ a: 1 })).not.toBe(digest({ a: 2 }));
  });

  it('is prefixed sha256:', () => {
    expect(digest({})).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('receiptDigest excludes itself and the signature so it can be recomputed', () => {
    const receipt = {
      schema_version: RECEIPT_SCHEMA,
      decision: 'pass',
      digests: { capsule: 'sha256:a', findings: 'sha256:b', evidence: 'sha256:c', receipt: '' },
      signature: null,
    } as unknown as ReviewReceipt;
    const first = receiptDigest(receipt);
    receipt.digests.receipt = first;
    receipt.signature = 'sig';
    expect(receiptDigest(receipt)).toBe(first);
  });

  it('findingFingerprint ignores claim whitespace and case', () => {
    const a = finding({ claim: 'The  handler   calls persistence.' });
    const b = finding({ claim: 'the handler calls PERSISTENCE.' });
    expect(findingFingerprint(a)).toBe(findingFingerprint(b));
  });

  it('findingFingerprint separates different kinds at the same path', () => {
    expect(findingFingerprint(finding({ kind: 'a' }))).not.toBe(findingFingerprint(finding({ kind: 'b' })));
  });

  it('receiptId is deterministic for the same inputs', () => {
    expect(receiptId(1_700_000_000_000, 'x')).toBe(receiptId(1_700_000_000_000, 'x'));
    expect(receiptId(1_700_000_000_000, 'x')).not.toBe(receiptId(1_700_000_000_000, 'y'));
    expect(receiptId(1_700_000_000_000, 'x')).toMatch(/^rvw_[0-9A-HJKMNP-TV-Z]+$/);
  });
});

// ── config (a PR must not weaken its own policy) ────────────────────────────

describe('review.toml', () => {
  it('parses the documented shape', () => {
    const cfg = parseReviewConfig(
      `
[review]
enforcement = "enforced"
fail_on = "needs_review"
target_pattern = "handler-service-repo"

[review.protected]
unguarded_entrypoint = false
`,
      'base-branch',
    );
    expect(cfg.enforcement).toBe('enforced');
    expect(cfg.fail_on).toBe('needs_review');
    expect(cfg.target_pattern).toBe('handler-service-repo');
    expect(cfg.protected.unguarded_entrypoint).toBe(false);
    // Unspecified protected rules keep their safe default.
    expect(cfg.protected.validated_taint).toBe(true);
  });

  it('falls back to defaults on malformed TOML', () => {
    const cfg = parseReviewConfig('this is not [ toml', 'head');
    expect(cfg.enforcement).toBe('advisory');
    expect(cfg.protected.unguarded_entrypoint).toBe(true);
  });

  it('ignores an unknown enforcement value rather than trusting it', () => {
    expect(parseReviewConfig('[review]\nenforcement = "off"', 'head').enforcement).toBe('advisory');
  });

  it('reads the base ref, not the working tree, when a base is given', () => {
    const calls: string[][] = [];
    const run: GitRunner = (args) => {
      calls.push(args);
      if (args[0] === 'show' && args[1]?.startsWith('origin/main:')) {
        return { stdout: '[review]\nenforcement = "enforced"\n', status: 0 };
      }
      return { stdout: '', status: 1 };
    };
    const cfg = loadReviewConfig('/repo', 'origin/main', run);
    expect(cfg.source).toBe('base-branch');
    expect(cfg.enforcement).toBe('enforced');
    expect(calls[0]).toEqual(['show', 'origin/main:.vibgrate/review.toml']);
  });

  it('prefers the base branch even when HEAD carries a weaker policy', () => {
    const run: GitRunner = (args) => {
      if (args[1] === 'origin/main:.vibgrate/review.toml') {
        return { stdout: '[review]\n[review.protected]\nunguarded_entrypoint = true\n', status: 0 };
      }
      if (args[1] === 'HEAD:.vibgrate/review.toml') {
        return { stdout: '[review]\n[review.protected]\nunguarded_entrypoint = false\n', status: 0 };
      }
      return { stdout: '', status: 1 };
    };
    expect(loadReviewConfig('/repo', 'origin/main', run).protected.unguarded_entrypoint).toBe(true);
  });
});

// ── git plumbing ────────────────────────────────────────────────────────────

describe('change set', () => {
  it('strips credentials from a remote URL', () => {
    expect(normalizeRemote('https://user:ghp_secret@github.com/acme/ledger.git')).toBe('github.com/acme/ledger');
    expect(normalizeRemote('git@github.com:acme/ledger.git')).toBe('github.com/acme/ledger');
    expect(normalizeRemote('https://github.com/acme/ledger')).toBe('github.com/acme/ledger');
  });

  it('never carries a secret into the repo key', () => {
    const withSecret = repoKey(normalizeRemote('https://u:ghp_secret@github.com/acme/x.git'), '/tmp/x');
    expect(withSecret).not.toContain('ghp_secret');
    expect(withSecret).toBe(repoKey('github.com/acme/x', '/tmp/x'));
  });

  it('reads base-side file text via git show so occupancy can be filtered', () => {
    const run: GitRunner = (args) => {
      if (args[0] === 'show' && args[1]?.endsWith(':src/api.ts')) {
        return { stdout: "import './repo'\n", status: 0 };
      }
      return { stdout: '', status: 1 };
    };
    const texts = readBaseFileTexts(
      {
        topLevel: '/repo',
        baseSha: 'a'.repeat(40),
        headSha: 'b'.repeat(40),
        mergeBase: null,
        ref: null,
        dirty: true,
        dirtyTreeHash: null,
        files: [{ path: 'src/api.ts', op: 'modified', addedLines: 1, removedLines: 0, hunks: [] }],
        remote: null,
      },
      run,
    );
    expect(texts.get('src/api.ts')).toContain("./repo");
    expect(texts.has('src/new.ts')).toBe(false);
  });

  it('stamps a stable repo_key the dashboard can recompute from the remote URL', () => {
    expect(repoKey('github.com/acme/ledger', '/unused')).toBe(
      'sha256:166afc033c12528fe9eacdfcf0fb03be960f41d2f666a4eee241e4ef44979510',
    );
  });

  it('excludes vg artifacts and build output from the change set', () => {
    expect(isReviewable('src/a.ts')).toBe(true);
    expect(isReviewable('.vibgrate/cache/parse-cache.json')).toBe(false);
    expect(isReviewable('packages/x/node_modules/y/index.js')).toBe(false);
    expect(isReviewable('dist/cli.js')).toBe(false);
  });

  it('parses merge-base mode from git output', () => {
    const run: GitRunner = (args) => {
      const key = args.join(' ');
      if (key.startsWith('rev-parse HEAD')) return { stdout: 'b'.repeat(40), status: 0 };
      if (key === 'rev-parse --show-toplevel') return { stdout: '/repo', status: 0 };
      if (key === 'rev-parse --abbrev-ref HEAD') return { stdout: 'feat/invoices', status: 0 };
      if (key === 'config --get remote.origin.url') return { stdout: 'git@github.com:acme/ledger.git', status: 0 };
      if (key.startsWith('merge-base')) return { stdout: 'a'.repeat(40), status: 0 };
      if (key.includes('--numstat')) return { stdout: '4\t2\tsrc/api/invoices.ts\n', status: 0 };
      if (key.includes('--name-status')) return { stdout: 'M\tsrc/api/invoices.ts\n', status: 0 };
      if (key.includes('-U0')) {
        return { stdout: '+++ b/src/api/invoices.ts\n@@ -41,2 +41,4 @@\n', status: 0 };
      }
      return { stdout: '', status: 1 };
    };
    const change = collectChangeSet('/repo', 'origin/main', run);
    expect(change.mergeBase).toBe('a'.repeat(40));
    expect(change.dirty).toBe(false);
    expect(change.ref).toBe('refs/heads/feat/invoices');
    expect(change.remote).toBe('github.com/acme/ledger');
    expect(change.files).toEqual([
      { path: 'src/api/invoices.ts', op: 'modified', addedLines: 4, removedLines: 2, hunks: [{ start: 41, end: 44 }] },
    ]);
  });

  it('marks the working tree dirty and hashes its shape', () => {
    const run: GitRunner = (args) => {
      const key = args.join(' ');
      if (key === 'rev-parse HEAD') return { stdout: 'c'.repeat(40), status: 0 };
      if (key === 'rev-parse --show-toplevel') return { stdout: '/repo', status: 0 };
      if (key === 'rev-parse --abbrev-ref HEAD') return { stdout: 'main', status: 0 };
      if (key === 'status --porcelain -uall') return { stdout: '?? src/new.ts\n', status: 0 };
      return { stdout: '', status: 0 };
    };
    const change = collectChangeSet('/repo', undefined, run);
    expect(change.dirty).toBe(true);
    expect(change.files[0]).toMatchObject({ path: 'src/new.ts', op: 'added' });
    expect(change.dirtyTreeHash).toMatch(/^sha256:/);
    expect(change.baseSha).toBe(change.headSha);
  });

  it('dirtyTreeHash changes when the change shape changes', () => {
    const a = dirtyTreeHash([{ path: 'a.ts', op: 'modified', addedLines: 1, removedLines: 0, hunks: [] }]);
    const b = dirtyTreeHash([{ path: 'a.ts', op: 'modified', addedLines: 2, removedLines: 0, hunks: [] }]);
    expect(a).not.toBe(b);
  });

  it('collects removed lines per path from a unified diff', () => {
    const diff = [
      '--- a/src/api.ts',
      '+++ b/src/api.ts',
      '@@ -1,3 +1,2 @@',
      '-  requireAuth(req)',
      '   return handler(req)',
      '+  // fast path',
    ].join('\n');
    expect(removedLinesFromDiff(diff).get('src/api.ts')).toEqual(['  requireAuth(req)']);
  });
});

// ── layer-skip rule ─────────────────────────────────────────────────────────

describe('evaluateLayerSkip', () => {
  it('flags routing depending straight on data-access', () => {
    const v = evaluateLayerSkip('layered', 'routing', 'data-access');
    expect(v.skipped).toBe(true);
    expect(v.bypassed).toEqual(['middleware', 'services']);
  });

  it('allows a hop to the adjacent tier', () => {
    expect(evaluateLayerSkip('layered', 'services', 'domain').skipped).toBe(false);
  });

  it('does not treat jumping over domain alone as a skip', () => {
    expect(evaluateLayerSkip('layered', 'services', 'data-access').skipped).toBe(false);
  });

  it('flags the outer ring reaching persistence under a clean profile', () => {
    // Clean/hexagonal/onion have no tier ranking to skip — dependencies point
    // inward — but they do have the rule that defines them: the two outer rings
    // must not touch. A controller holding a repository has bypassed the
    // application layer, which is the violation the style exists to prevent.
    // The engine's own clean rule covers only `domain → data-access`, so
    // without this a Clean Architecture repo gets no boundary finding at all.
    expect(evaluateLayerSkip('clean', 'routing', 'data-access').skipped).toBe(true);
    expect(evaluateLayerSkip('hexagonal', 'presentation', 'infrastructure').skipped).toBe(true);
    expect(evaluateLayerSkip('onion', 'middleware', 'data-access').skipped).toBe(true);
  });

  it('leaves inward dependencies alone under a clean profile', () => {
    // routing → services → domain is the shape the style asks for.
    expect(evaluateLayerSkip('clean', 'routing', 'services').skipped).toBe(false);
    expect(evaluateLayerSkip('clean', 'services', 'domain').skipped).toBe(false);
    // data-access → domain is how a repository references its entities.
    expect(evaluateLayerSkip('clean', 'data-access', 'domain').skipped).toBe(false);
  });

  it('does not apply to vertical slices, which are not layered at all', () => {
    expect(evaluateLayerSkip('vertical-slice', 'routing', 'infrastructure').skipped).toBe(false);
  });
});

// ── the explain layer ───────────────────────────────────────────────────────

describe('explain', () => {
  it('prefers a coder-tuned model', () => {
    const picked = pickExplainModel([
      { runtime: 'gguf', name: 'llama-3-8b', path: '/a' },
      { runtime: 'gguf', name: 'qwen2.5-coder-7b-instruct-Q4_K_M', path: '/b' },
    ]);
    expect(picked?.name).toContain('qwen2.5-coder');
  });

  it('returns null when nothing is installed, so the caller can fail closed', () => {
    expect(pickExplainModel([])).toBeNull();
  });

  it('folds implications into the matching finding', () => {
    const base = findings({ architecture_findings: [finding()] });
    const merged = mergeExplanations(
      base,
      JSON.stringify({
        implications: [
          { finding_id: 'arch-01', implication: 'It also bypasses the audit log.', remediation_intent: 'Go via the service.' },
        ],
        unknowns: ['No integration test covers the audit path.'],
      }),
    );
    expect(merged.architecture_findings[0].claim).toContain('bypasses the audit log');
    expect(merged.architecture_findings[0].remediation).toBe('Go via the service.');
    expect(merged.architecture_findings[0].source).toBe('model');
    expect(merged.unknowns).toContain('No integration test covers the audit path.');
  });

  it('drops unparseable model output rather than guessing', () => {
    const base = findings({ architecture_findings: [finding()] });
    expect(mergeExplanations(base, 'not json at all')).toEqual(base);
  });

  it('ignores an implication for a finding that does not exist', () => {
    const base = findings({ architecture_findings: [finding()] });
    const merged = mergeExplanations(
      base,
      JSON.stringify({ implications: [{ finding_id: 'arch-99', implication: 'x', remediation_intent: 'y' }] }),
    );
    expect(merged.architecture_findings[0]).toEqual(base.architecture_findings[0]);
  });

  it('cannot introduce a decision — the verifier rejects one if it tries', () => {
    const base = findings({ architecture_findings: [finding()] });
    const merged = mergeExplanations(base, JSON.stringify({ implications: [], unknowns: [] }));
    expect('decision' in merged).toBe(false);
    expect(verifyFindings(merged, capsule()).schema_valid).toBe(true);
  });
});

// ── CLI surface ─────────────────────────────────────────────────────────────

describe('vg review command surface', () => {
  it('registers `review` as a known command so the dispatcher routes it', async () => {
    const { KNOWN_COMMANDS } = await import('../cli.js');
    expect(KNOWN_COMMANDS.has('review')).toBe(true);
  });

  it('routes `vg review --out <file>` to review, not to ask', async () => {
    const { dispatch } = await import('../cli.js');
    expect(dispatch(['review', '--format', 'json', '--out', 'receipt.json'], '/repo')[0]).toBe('review');
  });

  it('does not mistake an --out value for a bare-word search query', async () => {
    const { dispatch } = await import('../cli.js');
    // `--out`'s value must be consumed as a value, never read as the first
    // positional — otherwise it would fall through to `ask`.
    expect(dispatch(['--out', 'receipt.json', 'review'], '/repo')[0]).toBe('review');
  });

  it('exposes the documented option names', async () => {
    const { buildProgram } = await import('../cli.js');
    const review = buildProgram().commands.find((c) => c.name() === 'review');
    expect(review).toBeDefined();
    const flags = review!.options.map((o) => o.long);
    for (const flag of ['--base', '--format', '--out', '--push', '--fail-on', '--explain']) {
      expect(flags).toContain(flag);
    }
    // Commander derives each option key from its long flag. A handler that
    // reads a differently-named key silently ignores the flag — which is
    // exactly the bug this assertion exists to catch.
    const outOption = review!.options.find((o) => o.long === '--out');
    expect(outOption!.attributeName()).toBe('out');
    expect(review!.options.find((o) => o.long === '--fail-on')!.attributeName()).toBe('failOn');
    expect(review!.options.find((o) => o.long === '--include-snippets')!.attributeName()).toBe('includeSnippets');
  });

  it('registers `vg review explain <finding-id>`', async () => {
    const { buildProgram } = await import('../cli.js');
    const review = buildProgram().commands.find((c) => c.name() === 'review');
    expect(review!.commands.map((c) => c.name())).toContain('explain');
  });

  it('refuses --push under --offline so an airgap cannot upload', () => {
    expect(() => rejectPushWhenOffline(true)).toThrow(CliError);
    try {
      rejectPushWhenOffline(true);
    } catch (e) {
      expect(e).toBeInstanceOf(CliError);
      expect((e as CliError).code).toBe(ExitCode.USAGE_ERROR);
      expect((e as CliError).message).toContain('drop `--offline`');
    }
    expect(() => rejectPushWhenOffline(false)).not.toThrow();
    expect(() => rejectPushWhenOffline(undefined)).not.toThrow();
  });
});

// ── `vg push` accepts a receipt (spec §3) ───────────────────────────────────

describe('vg push receipt discrimination', () => {
  it('recognises a receipt by its schema_version, not its filename', async () => {
    const { RECEIPT_SCHEMA } = await import('./schemas.js');
    expect(RECEIPT_SCHEMA).toBe('vg.review.receipt.v1');
    // A scan artifact uses camelCase `schemaVersion` and never collides.
    const scan = { schemaVersion: '1.0' } as Record<string, unknown>;
    expect(scan.schema_version).toBeUndefined();
  });

  it('builds an envelope that names the authenticated workspace', async () => {
    const { buildEnvelope } = await import('./push.js');
    const receipt = { workspace_id: null, decision: 'fail' } as never;
    const envelope = buildEnvelope(receipt, { workspaceId: 'ws_real', pushedAt: '2026-08-27T10:00:00Z' });
    expect(envelope.kind).toBe('review');
    expect(envelope.workspace_id).toBe('ws_real');
    expect(envelope.schema_version).toBe('vg.review.receipt.v1');
  });
});
