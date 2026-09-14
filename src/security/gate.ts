import { SECURITY_FINDING_SEVERITIES, type SecurityFinding, type SecuritySection, type SecuritySeverity } from './types.js';

/**
 * `--fail-on` parsing and the security gate (plan §2.7).
 *
 * `--fail-on` is a comma list. At most one *legacy* value — `warn`, `error`,
 * `architecture-finding`, `architecture-warning` — keeps its existing meaning
 * exactly; any number of security values add pack gates:
 *
 *   iac-finding[=<severity>]        the infrastructure pack, default `high`
 *   security-finding[=<severity>]   umbrella: every pack that ran, default `high`
 *
 * Thresholds compare the pack's own severity, never a rank.
 */

export type LegacyFailOn = 'warn' | 'error' | 'architecture-finding' | 'architecture-warning';

const LEGACY_VALUES: readonly LegacyFailOn[] = ['warn', 'error', 'architecture-finding', 'architecture-warning'];

/** A security gate class: `iac` is the infrastructure pack, `security` every pack. */
export type SecurityGateClass = 'iac' | 'security';

export interface SecurityGateRule {
  cls: SecurityGateClass;
  minSeverity: SecuritySeverity;
}

export interface ParsedFailOn {
  legacy?: LegacyFailOn;
  security: SecurityGateRule[];
  /** Set when the value could not be parsed; the message is user-facing. */
  invalid?: string;
}

const SECURITY_CLASS_BY_VALUE: Readonly<Record<string, SecurityGateClass>> = {
  'iac-finding': 'iac',
  'security-finding': 'security',
};

/** The pack ids a gate class covers; `security` covers whatever packs ran. */
const PACKS_BY_CLASS: Readonly<Record<SecurityGateClass, readonly string[] | null>> = {
  iac: ['iac-cis-v1'],
  security: null,
};

const DEFAULT_MIN_SEVERITY: SecuritySeverity = 'high';

const ACCEPTED_VALUES =
  'warn, error, architecture-finding, architecture-warning, iac-finding[=<severity>] or security-finding[=<severity>]';

function isSeverity(value: string): value is SecuritySeverity {
  return (SECURITY_FINDING_SEVERITIES as readonly string[]).includes(value);
}

/** Parse a raw `--fail-on` value. `undefined` → no gates. */
export function parseFailOn(raw: string | undefined): ParsedFailOn {
  const out: ParsedFailOn = { security: [] };
  if (raw === undefined) return out;
  const tokens = raw
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  if (!tokens.length) {
    return { security: [], invalid: `--fail-on needs a value: ${ACCEPTED_VALUES}` };
  }
  for (const token of tokens) {
    if ((LEGACY_VALUES as readonly string[]).includes(token)) {
      if (out.legacy !== undefined) {
        return {
          security: [],
          invalid: `--fail-on accepts only one of warn, error, architecture-finding, architecture-warning (got "${out.legacy}" and "${token}")`,
        };
      }
      out.legacy = token as LegacyFailOn;
      continue;
    }
    const eq = token.indexOf('=');
    const name = eq >= 0 ? token.slice(0, eq) : token;
    const cls = SECURITY_CLASS_BY_VALUE[name];
    if (!cls) {
      return { security: [], invalid: `unknown --fail-on value "${token}" (expected ${ACCEPTED_VALUES})` };
    }
    const threshold = eq >= 0 ? token.slice(eq + 1) : DEFAULT_MIN_SEVERITY;
    if (!isSeverity(threshold)) {
      return {
        security: [],
        invalid: `--fail-on ${name}=${threshold}: severity must be one of ${SECURITY_FINDING_SEVERITIES.join(', ')}`,
      };
    }
    out.security.push({ cls, minSeverity: threshold });
  }
  return out;
}

/** Rank of a severity for threshold comparison: critical is highest. */
export function severityRank(severity: SecuritySeverity): number {
  return SECURITY_FINDING_SEVERITIES.length - SECURITY_FINDING_SEVERITIES.indexOf(severity);
}

export interface SecurityGateOutcome {
  failed: boolean;
  /** Findings at or above a rule's threshold, in the section's order, each once. */
  matched: SecurityFinding[];
  /** Packs a rule needed that the installed module does not carry: the gate cannot pass. */
  unavailable: string[];
}

/** The packs a rule reads, given what the section says ran. */
function packsFor(rule: SecurityGateRule, section: SecuritySection): string[] {
  const fixed = PACKS_BY_CLASS[rule.cls];
  return fixed ? [...fixed] : Object.keys(section.packs).sort();
}

/**
 * Evaluate the security rules against a section. A finding matches when its
 * pack is covered by the rule and its severity is at or above the threshold.
 * A covered pack the module reports as `unavailable` fails the gate on its
 * own — an unevaluated pack is never a pass.
 */
export function evaluateSecurityGate(section: SecuritySection, rules: readonly SecurityGateRule[]): SecurityGateOutcome {
  const matchedIds = new Set<string>();
  const unavailable = new Set<string>();
  for (const rule of rules) {
    const packs = packsFor(rule, section);
    for (const pack of packs) {
      if (section.packs[pack] === undefined || section.packs[pack] === 'unavailable') unavailable.add(pack);
    }
    const threshold = severityRank(rule.minSeverity);
    for (const finding of section.findings) {
      if (!packs.includes(finding.pack)) continue;
      if (severityRank(finding.severity) < threshold) continue;
      matchedIds.add(finding.id);
    }
  }
  const matched = section.findings.filter((f) => matchedIds.has(f.id));
  const unavailableSorted = [...unavailable].sort();
  return { failed: matched.length > 0 || unavailableSorted.length > 0, matched, unavailable: unavailableSorted };
}

/** The lowest threshold among the rules, for a one-line "at or above <severity>" message. */
export function lowestThreshold(rules: readonly SecurityGateRule[]): SecuritySeverity {
  let lowest: SecuritySeverity = DEFAULT_MIN_SEVERITY;
  let lowestRank = Number.POSITIVE_INFINITY;
  for (const rule of rules) {
    const rank = severityRank(rule.minSeverity);
    if (rank < lowestRank) {
      lowestRank = rank;
      lowest = rule.minSeverity;
    }
  }
  return lowest;
}
