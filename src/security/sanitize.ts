import { redactSecrets } from '../core-open/utils/redact.js';
import { SECURITY_FINDING_SEVERITIES, type SecurityFinding, type SecuritySection, type SecuritySeverity } from './types.js';

/**
 * The trust boundary between the Architecture module and the artifact
 * (facts.md §1): everything the module returns is re-validated here before it
 * is printed, written or uploaded. Unknown fields are dropped, strings are
 * length-checked, ids must be 32 lowercase hex, and a finding that fails any
 * check is dropped rather than repaired. A result that fails at the top level
 * is `null`, which the caller reports as "abstained" — never as an empty pass.
 */

const ENGINE_MAX = 128;
const PACK_ID_MAX = 64;
const PACK_VERSION_MAX = 32;
const RULE_MAX = 128;
const MESSAGE_MAX = 512;
const PATH_MAX = 1024;
const ADDRESS_MAX = 512;
const TAXONOMY_ITEMS_MAX = 16;
const TAXONOMY_ITEM_MAX = 64;
const REJECTED_REASON_MAX = 128;
const REJECTED_MAX = 20_000;
const FINDINGS_MAX = 50_000;

const HEX32 = /^[0-9a-f]{32}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function boundedString(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : undefined;
}

function nonNegativeInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function isSeverity(value: unknown): value is SecuritySeverity {
  return typeof value === 'string' && (SECURITY_FINDING_SEVERITIES as readonly string[]).includes(value);
}

/** An optional string array: absent → undefined; present but malformed → null (finding dropped). */
function taxonomy(value: unknown): string[] | undefined | null {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > TAXONOMY_ITEMS_MAX) return null;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || item.length === 0 || item.length > TAXONOMY_ITEM_MAX) return null;
    out.push(item);
  }
  return out;
}

/** Validate one finding against the contract; null when it fails any check. */
export function sanitizeSecurityFinding(raw: unknown, allowedPacks: ReadonlySet<string>): SecurityFinding | null {
  if (!isRecord(raw)) return null;
  const id = typeof raw.id === 'string' && HEX32.test(raw.id) ? raw.id : undefined;
  const pack = boundedString(raw.pack, PACK_ID_MAX);
  const packVersion = boundedString(raw.packVersion, PACK_VERSION_MAX);
  const rule = boundedString(raw.rule, RULE_MAX);
  const message = boundedString(raw.message, MESSAGE_MAX);
  const path = boundedString(raw.path, PATH_MAX);
  if (!id || !pack || !packVersion || !rule || !message || !path || !isSeverity(raw.severity)) return null;
  if (!allowedPacks.has(pack)) return null;

  let line: number | undefined;
  if (raw.line !== undefined) {
    if (typeof raw.line !== 'number' || !Number.isInteger(raw.line) || raw.line < 1) return null;
    line = raw.line;
  }
  let address: string | undefined;
  if (raw.address !== undefined) {
    address = boundedString(raw.address, ADDRESS_MAX);
    if (address === undefined) return null;
  }
  let node: string | undefined;
  if (raw.node !== undefined) {
    if (typeof raw.node !== 'string' || !HEX32.test(raw.node)) return null;
    node = raw.node;
  }
  const owasp = taxonomy(raw.owasp);
  const cwe = taxonomy(raw.cwe);
  const cis = taxonomy(raw.cis);
  if (owasp === null || cwe === null || cis === null) return null;

  // A fresh object: unknown keys never pass through. The message is scrubbed
  // once more (the module promises no secret value; the boundary checks).
  return {
    id,
    pack,
    packVersion,
    rule,
    severity: raw.severity,
    message: redactSecrets(message),
    path,
    ...(line !== undefined ? { line } : {}),
    ...(address !== undefined ? { address } : {}),
    ...(node !== undefined ? { node } : {}),
    ...(owasp !== undefined ? { owasp } : {}),
    ...(cwe !== undefined ? { cwe } : {}),
    ...(cis !== undefined ? { cis } : {}),
  };
}

/** The contract's finding order: (path, line, address, rule, id); absent line sorts first, absent address as ''. */
export function compareFindings(a: SecurityFinding, b: SecurityFinding): number {
  const addressA = a.address ?? '';
  const addressB = b.address ?? '';
  return (
    (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) ||
    (a.line ?? 0) - (b.line ?? 0) ||
    (addressA < addressB ? -1 : addressA > addressB ? 1 : 0) ||
    (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/**
 * Validate a `vg.security.v1` result. `null` when the top level is not what
 * the contract says (wrong schema, missing engine/packs/facts) — the caller
 * treats that as the module abstaining. Findings for packs that were not
 * requested, and findings that fail any per-field check, are dropped.
 */
export function sanitizeSecurityResult(raw: unknown, requestedPacks: readonly string[]): SecuritySection | null {
  if (!isRecord(raw)) return null;
  if (raw.schema !== 'vg.security.v1') return null;
  const engine = boundedString(raw.engine, ENGINE_MAX);
  if (!engine) return null;

  if (!isRecord(raw.packs)) return null;
  const packs: Record<string, string> = {};
  for (const pack of [...requestedPacks].sort()) {
    const version = boundedString(raw.packs[pack], PACK_VERSION_MAX);
    // A requested pack the module says nothing about is, for the gate, unavailable.
    packs[pack] = version ?? 'unavailable';
  }

  if (!isRecord(raw.facts)) return null;
  const received = nonNegativeInt(raw.facts.received);
  const evaluated = nonNegativeInt(raw.facts.evaluated);
  const rejectedCount = nonNegativeInt(raw.facts.rejected);
  if (received === undefined || evaluated === undefined || rejectedCount === undefined) return null;

  let rejected: Array<{ index: number; reason: string }> | undefined;
  if (raw.rejected !== undefined) {
    if (!Array.isArray(raw.rejected)) return null;
    rejected = [];
    for (const entry of raw.rejected.slice(0, REJECTED_MAX)) {
      if (!isRecord(entry)) continue;
      const index = nonNegativeInt(entry.index);
      const reason = boundedString(entry.reason, REJECTED_REASON_MAX);
      if (index === undefined || reason === undefined) continue;
      rejected.push({ index, reason });
    }
    rejected.sort((a, b) => a.index - b.index || (a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0));
  }

  if (!Array.isArray(raw.findings)) return null;
  const allowed = new Set(Object.keys(packs));
  const findings: SecurityFinding[] = [];
  const seen = new Set<string>();
  for (const entry of raw.findings.slice(0, FINDINGS_MAX)) {
    const finding = sanitizeSecurityFinding(entry, allowed);
    if (!finding || seen.has(finding.id)) continue;
    seen.add(finding.id);
    findings.push(finding);
  }
  findings.sort(compareFindings);

  return {
    schema: 'vg.security.v1',
    engine,
    packs,
    facts: { received, evaluated, rejected: rejectedCount },
    ...(rejected !== undefined ? { rejected } : {}),
    findings,
  };
}
