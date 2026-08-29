/**
 * `apply_review_policy(capsule, findings) -> receipt.decision` (spec §5).
 *
 * Policy is the only layer that decides. It reads facts (capsule) and claims
 * (findings) and returns one of `pass` | `needs_review` | `fail` |
 * `undetermined`, plus the reasons that produced it.
 *
 * The load-bearing invariant: **no input may cause `pass` while an unresolved
 * protected fact is present.** That is asserted here, at the single exit point,
 * rather than trusted to each branch — so a future branch that forgets it still
 * cannot bless a protected finding.
 */

import { ExitCode } from '../util/exit.js';
import type { ReviewConfig } from './config.js';
import type {
  AnalysisCapsule,
  ReviewDecision,
  ReviewFinding,
  ReviewFindings,
} from './schemas.js';
import type { VerifyResult } from './verify.js';

export interface PolicyResult {
  decision: ReviewDecision;
  /** Why — one short line per contributing rule, in evaluation order. */
  reasons: string[];
  /**
   * True only if some branch attempted `pass` while an unresolved protected
   * fact was present. The invariant holds, so this is always false; the receipt
   * carries it to prove the check ran.
   */
  protectedFalseBless: boolean;
  quickPath: boolean;
  protectedCount: number;
}

/** Alignments that mean "this change moved toward what we said we wanted". */
const ALIGNED = new Set(['target', 'approved_exception']);

function isProtected(f: ReviewFinding): boolean {
  return f.protected_finding === true;
}

/**
 * A protected finding is "resolved" only when policy config has switched its
 * rule off. An approved exception does not resolve one — exceptions are scoped
 * and expiry-bound and produce a *new* receipt, they do not silence a fact.
 */
function unresolvedProtected(findings: ReviewFindings, config: ReviewConfig): ReviewFinding[] {
  const enabled = (kind: string): boolean => {
    if (kind === 'unguarded_entrypoint' || kind === 'guard_removed') return config.protected.unguarded_entrypoint;
    if (kind === 'known_vulnerable_dependency') return config.protected.known_vulnerable_dependency;
    if (kind === 'validated_taint') return config.protected.validated_taint;
    return true;
  };
  return [...findings.architecture_findings, ...findings.security_findings]
    .filter(isProtected)
    .filter((f) => enabled(f.kind));
}

export function applyReviewPolicy(
  capsule: AnalysisCapsule,
  findings: ReviewFindings,
  config: ReviewConfig,
  verification: VerifyResult,
): PolicyResult {
  const reasons: string[] = [];
  const all = [...findings.architecture_findings, ...findings.security_findings];
  const protectedFindings = unresolvedProtected(findings, config);
  const quickPath = findings.change_class.length === 1 && findings.change_class[0] === 'none';

  const decide = (): ReviewDecision => {
    // A findings document that failed verification is not evidence of anything.
    if (!verification.schema_valid || !verification.evidence_ids_valid) {
      reasons.push('the findings document failed schema or evidence verification — nothing here can be trusted to decide on');
      return 'undetermined';
    }

    // 1. Unresolved protected fact → fail. Nothing overrides this.
    if (protectedFindings.length > 0) {
      reasons.push(
        `${protectedFindings.length} protected finding(s) are unresolved: ${protectedFindings.map((f) => f.kind).join(', ')}`,
      );
      return 'fail';
    }

    // 2. Quick path: no material architectural or security-control delta.
    if (quickPath) {
      reasons.push('no material architectural or security-control delta in this change set');
      return 'pass';
    }

    // 3. High-severity, well-evidenced, calibrated findings.
    const high = all.filter(
      (f) =>
        (f.severity === 'high' || f.severity === 'critical')
        && !ALIGNED.has(f.target_alignment)
        && f.confidence >= config.high_confidence_threshold,
    );
    if (high.length > 0) {
      reasons.push(
        `${high.length} high-severity finding(s) at or above the ${config.high_confidence_threshold} confidence threshold`,
      );
      return config.high_severity_decision;
    }

    // 4. Unknowns, with no protected fact behind them.
    const blockingUnknowns = findings.unknowns.length > 0 || findings.required_checks.length > 0;

    // 5. Medium (or low-confidence high) findings that are not target-aligned.
    const material = all.filter((f) => !ALIGNED.has(f.target_alignment));
    if (material.length > 0) {
      reasons.push(`${material.length} finding(s) need a human look`);
      return 'needs_review';
    }

    if (blockingUnknowns) {
      // Nothing was found, but the review could not see enough to say `pass`.
      // `undetermined` is the honest answer, not a fake pass.
      reasons.push(
        `no findings, but ${findings.unknowns.length} unknown(s) and ${findings.required_checks.length} required check(s) remain`,
      );
      return capsule.patterns.unknown ? 'undetermined' : 'needs_review';
    }

    if (all.length > 0) {
      reasons.push('every finding is target-aligned or an approved exception');
    } else {
      reasons.push('no architecture or security-control findings in this change set');
    }
    return 'pass';
  };

  let decision = decide();

  // The invariant, asserted once at the exit. A `pass` here with an unresolved
  // protected fact would be a bug in a branch above; it is downgraded, and the
  // receipt records that the attempt happened.
  let protectedFalseBless = false;
  if (decision === 'pass' && protectedFindings.length > 0) {
    protectedFalseBless = true;
    decision = 'fail';
    reasons.push('policy attempted `pass` with an unresolved protected finding — downgraded to `fail`');
  }

  return {
    decision,
    reasons,
    protectedFalseBless,
    quickPath: quickPath && decision === 'pass',
    protectedCount: protectedFindings.length,
  };
}

/**
 * The gate level. `none` means report only — the decision still lands in the
 * receipt, but the process exits 0.
 */
export type FailOnLevel = 'none' | 'fail' | 'needs_review';

export const FAIL_ON_LEVELS: readonly FailOnLevel[] = ['none', 'fail', 'needs_review'];

/**
 * Exit code for a decision.
 *
 * **Gating is opt-in, exactly as it is for `vg scan`.** `vg scan` exits 0 no
 * matter what it finds unless you pass `--fail-on`; only then does crossing the
 * threshold exit `2`. Review follows that contract: without a gate, a `fail`
 * decision is still reported and still written to the receipt, but it does not
 * break the build. Enforcement is a decision the repository opts into, in
 * `.vibgrate/review.toml` or on the command line — never a default that turns
 * on the day someone installs the CLI.
 *
 * The failure code is `2` (`GATE_FAILED`), not `1`. Across this CLI `1` means a
 * *runtime error* — the command itself broke. A policy decision of `fail` is
 * the command working correctly and reporting a verdict, so it must not be
 * indistinguishable from a crash. `vg scan`, `vg drift` and `vg hcs gate` all
 * exit `2` for a gate failure; Review is not an exception to that.
 *
 * (The frozen spec's §3 table maps `fail` to `1`. That reading collides with
 * this CLI's stable exit-code contract, where `1` is reserved for errors, so
 * the repository convention wins. The decision itself is unambiguous in the
 * receipt, which is what machines should branch on.)
 */
export function exitCodeForDecision(decision: ReviewDecision, failOn: FailOnLevel): number {
  if (failOn === 'none') return 0;
  if (decision === 'fail') return ExitCode.GATE_FAILED;
  if (failOn === 'needs_review' && (decision === 'needs_review' || decision === 'undetermined')) {
    return ExitCode.GATE_FAILED;
  }
  return 0;
}

/**
 * The effective gate for a run: an explicit `--fail-on` always wins; otherwise
 * the repository's config decides, and `enforcement = "advisory"` means no gate.
 *
 * This is what makes `enforcement` mean something. Before, `fail_on` gated
 * regardless and `advisory` was a label on the receipt that changed nothing.
 */
export function resolveFailOn(
  flag: FailOnLevel | undefined,
  config: Pick<ReviewConfig, 'enforcement' | 'fail_on'>,
): FailOnLevel {
  if (flag) return flag;
  return config.enforcement === 'enforced' ? config.fail_on : 'none';
}
