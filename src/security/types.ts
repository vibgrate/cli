/**
 * Types of the security-pack host (`vg scan --iac`).
 *
 * The finding and section shapes live in core-open (`ExtendedScanResults.
 * security`) because the formatters there print them; this module re-exports
 * them so the host has one source of truth. The fact document is host-only:
 * it is built in memory, handed to the Architecture module, and never written
 * to disk (docs/CLI-SECURITY-PACKS-PLAN.md §2.2). The contract for both is
 * `packages/vibgrate-haile/docs/facts.md`.
 */
import type { SecuritySeverity } from '../core-open/index.js';

export type { SecurityFinding, SecuritySection, SecuritySeverity } from '../core-open/index.js';

/** Severities a pack may stamp, most severe first. The order is the gate's ordering. */
export const SECURITY_FINDING_SEVERITIES = [
  'critical',
  'high',
  'medium',
  'low',
  'info',
] as const satisfies readonly SecuritySeverity[];

/** Fact kinds of wave 1 (facts.md §2.1). Closed: the module rejects anything else. */
export type FactKind = 'tf.resource' | 'tf.module' | 'tf.provider' | 'k8s.object' | 'docker.stage' | 'helm.chart';

/** One fact of a `vg.facts.v1` document. */
export interface Fact {
  kind: FactKind;
  /** Repo-relative, forward slashes. */
  path: string;
  /** 1-based; evidence only, never part of a finding id. */
  line?: number;
  /** Identity within the file (facts.md §2.1, per kind). */
  address: string;
  /** The graph node id (32 hex) the fact binds to — the draft's own id. */
  node?: string;
  /** Closed per-kind projection (facts.md §2.2). Never a secret value. */
  attrs: Record<string, unknown>;
}

/** The closed input document of `vg_eval_facts`. Top-level keys are exactly these three. */
export interface FactDocument {
  schema: 'vg.facts.v1';
  packs: string[];
  /** Sorted by (kind, path, address). */
  facts: Fact[];
}

/** Host-enforced cap on facts per document (facts.md §2 "Caps"). */
export const FACT_DOCUMENT_MAX_FACTS = 20_000;
