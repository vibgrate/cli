/**
 * Deterministic review scanners — the layer that owns *facts*.
 *
 * Every finding here is derived from the code map, the diff, or a scan artifact
 * that already exists on disk. Nothing is inferred by a model, nothing is
 * guessed, and where a fact cannot be established the scanner emits an
 * `unknown` rather than an absence (GUARDRAILS: absent ≠ zero).
 *
 * Three of these rules are **protected** (spec §1): an unguarded entrypoint, a
 * validated taint flow, and a known-vulnerable dependency. A protected finding
 * carries `protected_finding: true` all the way to the receipt, and policy may
 * never emit `pass` while one is unresolved — no model output can bless it.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { evaluateLayerBoundary } from '../core-open/scanners/architecture/graph-refine.js';
import { evaluateLayerSkip } from './layers.js';
import { describePattern, isRegression, type DataAccessPattern } from './dimensions.js';
import type { DominanceVote } from './dominance.js';
import { classifyRoute, voteAllAuth, type ClassifiedRoute } from './auth.js';
import { routesForFile } from './routes.js';
import { isComparable, SimilarityIndex, type FunctionBody } from './similarity.js';
import type { ArchitectureLayer } from '../core-open/types.js';
import type { ReviewConfig } from './config.js';
import type { ChangeSet } from './git.js';
import type { AnalysisCapsule, ReviewFinding, TargetAlignment } from './schemas.js';

const EXEMPT_LAYERS = new Set<ArchitectureLayer>(['config', 'shared', 'testing']);

/** Files whose change is a dependency change, per ecosystem. */
const DEPENDENCY_MANIFESTS =
  /(^|\/)(package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|.*\.csproj|packages\.lock\.json|Directory\.Packages\.props|requirements.*\.txt|pyproject\.toml|poetry\.lock|go\.mod|go\.sum|Cargo\.toml|Cargo\.lock|pom\.xml|build\.gradle(\.kts)?|Gemfile(\.lock)?|composer\.(json|lock))$/i;

/**
 * Call shapes that read as an authorization / validation guard. Deliberately
 * broad in *recognising* a guard and narrow in *claiming its absence*: a false
 * "guard present" would silently downgrade a real finding, so recognition is
 * generous and the absence claim is only made for entrypoint-role files.
 */
const GUARD_PATTERNS: readonly RegExp[] = [
  /\b(authorize|authorise|authenticate|requireAuth|requireUser|ensureAuth|checkPermission|hasPermission|can|verifyToken|verifyJwt|assertScope|requireScope|guard)\s*\(/i,
  /\[\s*Authorize\b/, // C# attribute
  /@(PreAuthorize|Secured|RolesAllowed|UseGuards)\b/, // Spring / Nest
  /\buse(Auth|Guard|Session)\b/,
  /\b(csrf|rateLimit|validateRequest|zod|schema)\.(parse|safeParse|validate)\s*\(/i,
];

/** Roles whose files are entrypoints — the surface an unguarded change exposes. */
const ENTRYPOINT_LAYERS = new Set<ArchitectureLayer>(['routing', 'middleware']);
const ENTRYPOINT_ROLES = new Set(['controller', 'handler', 'router']);

export interface ScanInput {
  root: string;
  capsule: AnalysisCapsule;
  change: ChangeSet;
  config: ReviewConfig;
  /** Removed diff lines per path, used for guard-removal detection. */
  removedLines: Map<string, string[]>;
  /** Current file text per changed path (absent for a deletion). */
  fileText: Map<string, string>;
  /** Vulnerable packages from an existing scan artifact, if one is on disk. */
  vulnerablePackages: { package: string; detail: string }[] | null;
  /** Peer dominance votes, keyed by group. */
  votes?: DominanceVote[];
  /** Every file's data-access label. */
  dataAccess?: Map<string, DataAccessPattern>;
  /** Repo-relative paths in this change set. */
  changedPaths?: Set<string>;
  /**
   * Text of unchanged route-bearing files, so the auth vote has peers. The
   * changed files alone are too small a sample to establish a convention.
   */
  peerFileText?: Map<string, string>;
  /** Prebuilt similarity index over the repository's existing function bodies. */
  similarity?: SimilarityIndex;
  /** Function bodies introduced or modified by this change. */
  changedBodies?: FunctionBody[];
}

export interface ScanOutput {
  architecture: ReviewFinding[];
  security: ReviewFinding[];
  unknowns: string[];
  requiredChecks: string[];
}

function alignment(
  capsule: AnalysisCapsule,
  fromLayer: string | undefined,
  toLayer: string | undefined,
): TargetAlignment {
  const pair = `${fromLayer}->${toLayer}`;
  if (capsule.patterns.approved_exceptions.includes(pair)) return 'approved_exception';
  if (capsule.patterns.unknown) return 'unknown';
  if (capsule.patterns.declared_target_pattern) return 'regression';
  // No declared target: the repo's own majority is context, not correctness.
  return 'legacy_consistent';
}

export function runScanners(input: ScanInput): ScanOutput {
  const { capsule, config } = input;
  const architecture: ReviewFinding[] = [];
  const security: ReviewFinding[] = [];
  const unknowns: string[] = [];
  const requiredChecks: string[] = [];

  // ── 1. Boundary bypass ───────────────────────────────────────────────────
  const profile = capsule.patterns.declared_target_pattern ?? capsule.patterns.observed_dominant_pattern;
  if (profile) {
    let n = 0;
    for (const edge of capsule.change.added_edges) {
      const from = edge.from_layer as ArchitectureLayer | undefined;
      const to = edge.to_layer as ArchitectureLayer | undefined;
      if (!from || !to) continue;
      if (EXEMPT_LAYERS.has(from) || EXEMPT_LAYERS.has(to)) continue;
      const illegal = evaluateLayerBoundary(profile, from, to, edge.from_path, edge.to_path);
      // A skip is only a regression against a *declared* target — see layers.ts.
      const skip = capsule.patterns.declared_target_pattern
        ? evaluateLayerSkip(profile, from, to)
        : { skipped: false, bypassed: [], rule: '' };
      if (!illegal.illegal && !skip.skipped) continue;
      const align = alignment(capsule, from, to);
      const declared = Boolean(capsule.patterns.declared_target_pattern);
      n++;
      architecture.push({
        id: `arch-${String(n).padStart(2, '0')}`,
        kind: 'boundary_bypass',
        // A declared target makes this a regression against a stated intent;
        // without one it is an observation about the repo's own majority.
        severity: declared ? 'high' : 'medium',
        confidence: declared ? 0.93 : 0.6,
        claim: skip.skipped
          ? `A changed ${from} file depends directly on ${to}, skipping ${skip.bypassed.join(', ')} (${edge.from_path} → ${edge.to_path}).`
          : `A changed ${from} file depends on ${to}, against the ${illegal.rule} rule (${edge.from_path} → ${edge.to_path}).`,
        evidence_ids: [edge.evidence_id, ...policyEvidenceIds(capsule)],
        target_alignment: align,
        remediation: `Route the operation through the ${intermediateLayer(from, to)} layer instead of calling ${to} directly.`,
        paths: [edge.from_path, edge.to_path],
        protected_finding: false,
        source: 'scanner',
      });
    }
  }

  // ── 2. Guard removed from an entrypoint (protected) ──────────────────────
  let sec = 0;
  if (config.protected.unguarded_entrypoint) {
    for (const [filePath, lines] of [...input.removedLines.entries()].sort()) {
      const removedGuards = lines.filter((l) => GUARD_PATTERNS.some((p) => p.test(l)));
      if (removedGuards.length === 0) continue;
      const stillGuarded = GUARD_PATTERNS.some((p) => p.test(input.fileText.get(filePath) ?? ''));
      if (stillGuarded) continue;
      sec++;
      security.push({
        id: `sec-${String(sec).padStart(2, '0')}`,
        kind: 'guard_removed',
        severity: 'high',
        confidence: 0.9,
        claim: `An authorization or validation guard was removed from ${filePath} and no equivalent guard remains in the file.`,
        evidence_ids: [roleEvidenceFor(capsule, filePath) ?? sourceSpanEvidence(capsule, filePath)],
        target_alignment: 'regression',
        remediation: 'Restore the guard, or move it to a middleware the changed path provably passes through.',
        paths: [filePath],
        protected_finding: true,
        source: 'scanner',
      });
    }
  }

  // ── 3. Unguarded route (protected) ───────────────────────────────────────
  // Route-level, not file-level, and voted against peers. Three properties make
  // this safe to hang a *protected* finding on:
  //
  //   - a route we could not classify is `unsure` and produces no finding, only
  //     an unknown — claiming "guarded" or "open" on a guess is the one failure
  //     that would make the protected invariant a lie;
  //   - only mutating methods vote, so a codebase that deliberately leaves reads
  //     open still has a readable convention on its writes;
  //   - below MIN_SECURITY_PEERS classified peers the finding is advisory and
  //     cannot gate, because "most routes here are guarded" is not a claim four
  //     routes can support.
  if (config.protected.unguarded_entrypoint) {
    const classified: ClassifiedRoute[] = [];
    for (const [filePath, text] of [...input.fileText.entries()].sort()) {
      for (const route of routesForFile(filePath, text)) classified.push(classifyRoute(route));
    }
    // Peers come from the wider route surface; the changed files alone are too
    // small a sample to establish a convention.
    for (const [filePath, text] of [...(input.peerFileText?.entries() ?? [])].sort()) {
      if (input.fileText.has(filePath)) continue;
      for (const route of routesForFile(filePath, text)) classified.push(classifyRoute(route));
    }

    const changedFiles = input.changedPaths ?? new Set<string>();
    for (const vote of voteAllAuth(classified)) {
      for (const route of vote.deviators) {
        if (!changedFiles.has(route.file)) continue;
        sec++;
        security.push({
          id: `sec-${String(sec).padStart(2, '0')}`,
          kind: 'unguarded_entrypoint',
          severity: vote.aboveFloor ? 'high' : 'medium',
          confidence: vote.aboveFloor ? Math.min(0.95, vote.share) : 0.5,
          claim:
            `${route.method} ${route.path || route.file} has no authorization guard in scope, while `
            + `${vote.guarded} of ${vote.classified} mutating routes in ${vote.group} do (${route.rule}).`,
          evidence_ids: [roleEvidenceFor(capsule, route.file) ?? sourceSpanEvidence(capsule, route.file)],
          target_alignment: 'regression',
          remediation:
            'Add an authorization check, or register the route behind a middleware it provably passes through.',
          paths: [route.file],
          // Below the peer floor this is a real observation but not a claim
          // strong enough to block a merge, so it must not be protected.
          protected_finding: vote.aboveFloor,
          source: 'scanner',
        });
        if (vote.aboveFloor) requiredChecks.push('authz-test');
      }

      // Routes we could not classify are reported, never assumed safe.
      const changedUnsure = vote.unsure.filter((r) => changedFiles.has(r.file));
      if (changedUnsure.length > 0) {
        unknowns.push(
          `${changedUnsure.length} changed route(s) in ${vote.group} could not be classified as guarded or open `
          + `(${[...new Set(changedUnsure.map((r) => r.rule))].join(', ')}) — neither confirmed nor excluded.`,
        );
      }
    }
  }

  // ── 4. Known-vulnerable dependency (protected) ───────────────────────────
  const dependencyChanges = capsule.change.ops.filter((o) => DEPENDENCY_MANIFESTS.test(o.path));
  if (config.protected.known_vulnerable_dependency && dependencyChanges.length > 0) {
    if (input.vulnerablePackages === null) {
      // No advisory data on disk. Absent ≠ zero: this is an unknown, and it
      // keeps the change out of `pass` rather than silently blessing it.
      unknowns.push(
        `${dependencyChanges.length} dependency manifest(s) changed and no advisory data was available — run \`vg scan --vulns\` so \`vg review\` can check them.`,
      );
      requiredChecks.push('dependency-advisory-check');
    } else {
      for (const vuln of input.vulnerablePackages) {
        const declaredIn = dependencyChanges.find((o) =>
          (input.fileText.get(o.path) ?? '').includes(vuln.package),
        );
        if (!declaredIn) continue;
        sec++;
        security.push({
          id: `sec-${String(sec).padStart(2, '0')}`,
          kind: 'known_vulnerable_dependency',
          severity: 'high',
          confidence: 1,
          claim: `A changed dependency manifest declares ${vuln.package}, which has a known advisory: ${vuln.detail}`,
          evidence_ids: [dependencyEvidence(capsule, declaredIn.path)],
          target_alignment: 'regression',
          remediation: 'Upgrade to a fixed version, or record a scoped, expiry-bound exception.',
          paths: [declaredIn.path],
          protected_finding: true,
          source: 'scanner',
        });
      }
    }
  }

  // ── 5. Validated taint — not run in this slice ───────────────────────────
  // Reported only where it could have changed the answer: a change that touches
  // no entrypoint and no cross-layer path has no tainted-input surface for this
  // slice to have missed, and claiming otherwise on every review would make
  // `pass` unreachable rather than honest.
  const hasTaintSurface =
    capsule.paths.length > 0
    || capsule.roles.some(
      (r) => r.changed && (ENTRYPOINT_ROLES.has(r.role) || ENTRYPOINT_LAYERS.has(r.layer as ArchitectureLayer)),
    );
  if (config.protected.validated_taint && hasTaintSurface) {
    unknowns.push('This change touches an entrypoint or a cross-layer path and taint validation was not run — dataflow analysis is not part of this review slice, so tainted-input findings are neither confirmed nor excluded.');
  }

  // ── 6. Peer deviation (the dominance vote) ───────────────────────────────
  // Distinct from rule-based boundary_bypass above: this one asks "do this
  // file's peers do it differently?" rather than "does a layering rule forbid
  // it?". A repository with no declared target still gets a useful signal here,
  // and one *with* a declared target gets a second, independent witness.
  for (const vote of input.votes ?? []) {
    if (vote.reason !== 'dominant' || !vote.dominant) continue;
    const changedDeviators = vote.deviators.filter((p) => input.changedPaths?.has(p));
    if (changedDeviators.length === 0) continue;

    for (const filePath of changedDeviators) {
      const actual = input.dataAccess?.get(filePath);
      if (!actual) continue;
      // Only flag a step *away* from the architecture. A file that reaches
      // persistence through a service while its peers do it directly is the
      // first one to improve — flagging it would punish modernisation, which
      // is exactly what "majority is not correctness" forbids.
      if (!isRegression(actual, vote.dominant as DataAccessPattern)) continue;

      const declared = Boolean(capsule.patterns.declared_target_pattern);
      architecture.push({
        id: `arch-${String(architecture.length + 1).padStart(2, '0')}`,
        kind: 'peer_deviation',
        severity: declared ? 'high' : 'medium',
        // The vote's own share is the calibration: a 100%-consistent group of
        // 20 peers is far stronger evidence than a bare 70% of 3.
        confidence: Math.min(0.95, vote.share * Math.min(1, vote.size / 8)),
        claim:
          `${filePath} ${describePattern(actual)}, while ${(vote.share * 100).toFixed(0)}% of its `
          + `${vote.size} ${vote.groupKind} peers ${describePattern(vote.dominant)}.`,
        evidence_ids: [`vote:${vote.group}`, ...policyEvidenceIds(capsule)].filter((id) =>
          capsule.evidence.some((e) => e.id === id),
        ),
        target_alignment: alignment(capsule, undefined, undefined),
        remediation: `Follow the pattern its peers use — see ${vote.exemplars.slice(0, 2).join(', ') || 'the peer group'}.`,
        paths: [filePath],
        protected_finding: false,
        source: 'scanner',
      });
    }
  }

  // ── 7. Re-implementation of code that already exists ─────────────────────
  // The question an agent is worst at: it cannot see the rest of the repository
  // while it writes, so it rebuilds what is already there under a new name.
  // Each copy is individually fine, which is why no linter catches it.
  if (input.similarity && input.changedBodies) {
    const changedIds = new Set(input.changedBodies.map((b) => b.id));
    const reported = new Set<string>();
    for (const body of input.changedBodies) {
      if (!isComparable(body.file)) continue;
      const hits = input.similarity.find(body, changedIds).filter((h) => isComparable(h.file));
      if (hits.length === 0) continue;
      // One finding per changed function, not per pair — five near-identical
      // hits are one problem, and listing them separately buries everything else.
      const key = `${body.file}:${body.name}`;
      if (reported.has(key)) continue;
      reported.add(key);

      const best = hits[0];
      architecture.push({
        id: `arch-${String(architecture.length + 1).padStart(2, '0')}`,
        kind: 'duplicate_implementation',
        severity: 'medium',
        confidence: Math.min(0.9, best.score),
        claim:
          `${body.name} in ${body.file} is structurally ${(best.score * 100).toFixed(0)}% the same as `
          + `${best.name} in ${best.file}:${best.startLine}`
          + (hits.length > 1 ? ` (and ${hits.length - 1} other near-match(es))` : '')
          + '.',
        evidence_ids: [duplicateEvidence(capsule, body, best)],
        // Reusing what exists is what the architecture wants; this is a
        // deviation from that, but never a *security* regression.
        target_alignment: capsule.patterns.declared_target_pattern ? 'regression' : 'unknown',
        remediation: `Call ${best.name} instead, or extract the shared behaviour if the two genuinely differ.`,
        paths: [body.file, best.file],
        protected_finding: false,
        source: 'scanner',
      });
    }
  }

  // ── 8. Changed behaviour with no covering test ───────────────────────────
  const untested = capsule.verification.filter((v) => v.kind === 'no_test_covering_change');
  if (untested.length > 0) {
    architecture.push({
      id: `arch-${String(architecture.length + 1).padStart(2, '0')}`,
      kind: 'unverified_change',
      severity: 'medium',
      confidence: 0.7,
      claim: `${untested.length} changed file(s) have no test edge reaching them in the code map.`,
      evidence_ids: untested.slice(0, 8).map((v) => v.evidence_id),
      target_alignment: 'unknown',
      remediation: 'Add a test that exercises the changed call path, or point `vg build` at the coverage report that already covers it.',
      paths: untested.map((v) => v.path).slice(0, 25),
      protected_finding: false,
      source: 'scanner',
    });
    requiredChecks.push('changed-call-path-test');
  }

  return {
    architecture,
    security,
    unknowns,
    requiredChecks: [...new Set(requiredChecks)].sort(),
  };
}

function policyEvidenceIds(capsule: AnalysisCapsule): string[] {
  return capsule.policies.slice(0, 2).map((p) => p.evidence_id);
}

function roleEvidenceFor(capsule: AnalysisCapsule, filePath: string): string | null {
  return capsule.roles.find((r) => r.path === filePath)?.evidence_id ?? null;
}

/**
 * Evidence of last resort: the change op itself. Every finding must cite an id
 * present in the capsule, so a scanner that has nothing better cites the file's
 * own role entry — never an invented id (the verifier would reject it).
 */
function sourceSpanEvidence(capsule: AnalysisCapsule, filePath: string): string {
  const existing = capsule.evidence.find((e) => e.path === filePath);
  if (existing) return existing.id;
  const id = `source_span:${capsule.evidence.length + 1}`;
  capsule.evidence.push({ id, kind: 'source_span', path: filePath, protected_finding: true });
  return id;
}

/** Evidence for a duplicate pair: both spans, so `explain` can show them. */
function duplicateEvidence(
  capsule: AnalysisCapsule,
  body: { file: string; name: string; startLine: number; endLine: number },
  match: { file: string; name: string; startLine: number; endLine: number },
): string {
  const id = `duplicate:${body.file}:${body.name}`;
  if (!capsule.evidence.some((e) => e.id === id)) {
    capsule.evidence.push({
      id,
      kind: 'graph_node',
      path: match.file,
      start_line: match.startLine,
      end_line: match.endLine,
      protected_finding: false,
      note: `${body.name} (${body.file}:${body.startLine}) ~= ${match.name} (${match.file}:${match.startLine})`,
    });
  }
  return id;
}

function dependencyEvidence(capsule: AnalysisCapsule, filePath: string): string {
  const existing = capsule.evidence.find((e) => e.kind === 'dependency' && e.path === filePath);
  if (existing) return existing.id;
  const id = `dependency:${filePath}`;
  capsule.evidence.push({ id, kind: 'dependency', path: filePath, protected_finding: true });
  return id;
}

/** The layer a bypassed dependency should have gone through. */
function intermediateLayer(from: ArchitectureLayer, to: ArchitectureLayer): string {
  if (to === 'data-access' || to === 'infrastructure') return 'application service';
  if (from === 'domain') return 'port / interface';
  return 'service';
}

/** Removed diff lines per path, from a unified diff. Never retains added text. */
export function removedLinesFromDiff(diff: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  let current: string | null = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('--- ')) continue;
    if (line.startsWith('+++ ')) {
      const p = line.slice(4).trim();
      current = p === '/dev/null' ? null : p.replace(/^b\//, '');
      if (current && !map.has(current)) map.set(current, []);
      continue;
    }
    if (current && line.startsWith('-') && !line.startsWith('---')) {
      map.get(current)!.push(line.slice(1));
    }
  }
  return map;
}

/**
 * Vulnerable packages from an on-disk scan artifact, or `null` when no artifact
 * exists. `null` and `[]` mean different things: "not checked" vs "checked, none".
 */
export function vulnerablePackagesFromScan(root: string): { package: string; detail: string }[] | null {
  const file = path.join(root, '.vibgrate', 'scan_result.json');
  if (!fs.existsSync(file)) return null;
  try {
    const artifact = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      findings?: { ruleId: string; message: string; location: string; details?: Record<string, unknown> }[];
    };
    const findings = (artifact.findings ?? []).filter((f) => f.ruleId === 'vibgrate/vulnerability');
    return findings.map((f) => ({
      package: String(f.details?.package ?? f.location),
      detail: f.message,
    }));
  } catch {
    return null;
  }
}
