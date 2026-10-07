// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import { createHash } from 'node:crypto';
import type { BaselineSuppression, ScanArtifact, Finding, SecurityFinding, SecuritySection, SecuritySeverity } from '../types.js';

/**
 * `partialFingerprints` key on every `vg scan` SARIF result.
 * Security-pack results and baseline suppressions keep the id they already
 * published under this key. Other drift results use {@link driftResultFingerprint}.
 */
const FINDING_FINGERPRINT_KEY = 'vg/finding-id/v1';

/**
 * Detail keys that move with the clock. They stay on `properties` and in the
 * message, and they never enter the fingerprint.
 */
const CLOCK_DETAIL_KEYS = new Set(['exposureDays', 'introducedDate']);

/**
 * Generate a SARIF 2.1.0 document from scan artifact.
 *
 * The first run carries the drift findings. When the artifact carries
 * security-pack findings (`extended.security`, from `vg scan --iac`), a
 * second run is appended for them — one run per artifact, with every pack
 * listed under `tool.extensions`. A scan that ran no pack still emits one run.
 * Every result carries `partialFingerprints["vg/finding-id/v1"]`.
 */
export function formatSarif(artifact: ScanArtifact): object {
  const suppressed = suppressionIndex(artifact);
  const rules = buildRules(artifact.findings);
  const results = artifact.findings.map((f) => toSarifResult(f, suppressed.get(suppressionKey(f.ruleId, f.location))));

  const runs: object[] = [
    {
      tool: {
        driver: {
          name: 'vibgrate',
          version: artifact.vibgrateVersion,
          informationUri: 'https://vibgrate.com',
          rules,
        },
      },
      results,
      invocations: [
        {
          executionSuccessful: true,
          startTimeUtc: artifact.timestamp,
        },
      ],
    },
  ];

  const security = artifact.extended?.security;
  if (security?.findings?.length) {
    runs.push(securityRun(security, artifact));
  }

  return {
    $schema: 'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json',
    version: '2.1.0',
    runs,
  };
}

/** SARIF `level` for a pack severity: critical/high → error, medium → warning, low/info → note. */
export function sarifLevelForSeverity(severity: SecuritySeverity): 'error' | 'warning' | 'note' {
  if (severity === 'critical' || severity === 'high') return 'error';
  if (severity === 'medium') return 'warning';
  return 'note';
}

/** The `<pack>/<rule>` SARIF rule id of a security finding. */
function securityRuleId(f: SecurityFinding): string {
  return `${f.pack}/${f.rule}`;
}

/**
 * The security-pack run. Rules are one per distinct `<pack>/<rule>`, in
 * first-seen order of the (already sorted) findings; taxonomy properties come
 * from the first finding that carries them. Results keep the module's order.
 */
function securityRun(security: SecuritySection, artifact: ScanArtifact): object {
  const rules: object[] = [];
  const seenRules = new Set<string>();
  for (const f of security.findings) {
    const id = securityRuleId(f);
    if (seenRules.has(id)) continue;
    seenRules.add(id);
    rules.push({
      id,
      shortDescription: { text: f.rule },
      helpUri: `https://vibgrate.com/rules/${f.pack}/${f.rule}`,
      properties: {
        owasp: f.owasp ?? [],
        cwe: f.cwe ?? [],
        cis: f.cis ?? [],
      },
    });
  }

  const extensions = Object.keys(security.packs)
    .sort()
    .filter((pack) => security.packs[pack] !== 'unavailable')
    .map((pack) => ({ name: pack, version: security.packs[pack] }));

  const results = security.findings.map((f) => ({
    ruleId: securityRuleId(f),
    level: sarifLevelForSeverity(f.severity),
    message: { text: f.message },
    locations: [
      {
        physicalLocation: {
          artifactLocation: { uri: f.path },
          ...(typeof f.line === 'number' ? { region: { startLine: f.line } } : {}),
        },
      },
    ],
    // Stable across a move of the block and a rename that keeps the address —
    // what code-scanning UIs key "same finding as last time" on.
    partialFingerprints: { [FINDING_FINGERPRINT_KEY]: f.id },
    properties: {
      severity: f.severity,
      address: f.address ?? '',
      ...(f.node ? { node: f.node } : {}),
      owasp: f.owasp ?? [],
      cwe: f.cwe ?? [],
      cis: f.cis ?? [],
      engine: security.engine,
    },
  }));

  return {
    tool: {
      driver: {
        name: 'Vibgrate CLI',
        version: artifact.vibgrateVersion,
        informationUri: 'https://vibgrate.com',
        rules,
      },
      extensions,
    },
    results,
    invocations: [
      {
        executionSuccessful: true,
        startTimeUtc: artifact.timestamp,
      },
    ],
  };
}

function buildRules(findings: Finding[]) {
  const ruleIds = [...new Set(findings.map((f) => f.ruleId))];
  return ruleIds.map((id) => {
    const descriptions: Record<string, { id: string; shortDescription: { text: string }; helpUri: string }> = {
      'vibgrate/runtime-eol': {
        id: 'vibgrate/runtime-eol',
        shortDescription: { text: 'Runtime at or past end-of-life' },
        helpUri: 'https://vibgrate.com/rules/runtime-eol',
      },
      'vibgrate/runtime-lag': {
        id: 'vibgrate/runtime-lag',
        shortDescription: { text: 'Runtime major version lag' },
        helpUri: 'https://vibgrate.com/rules/runtime-lag',
      },
      'vibgrate/framework-major-lag': {
        id: 'vibgrate/framework-major-lag',
        shortDescription: { text: 'Framework major version behind latest' },
        helpUri: 'https://vibgrate.com/rules/framework-major-lag',
      },
      'vibgrate/dependency-rot': {
        id: 'vibgrate/dependency-rot',
        shortDescription: { text: 'High percentage of outdated dependencies' },
        helpUri: 'https://vibgrate.com/rules/dependency-rot',
      },
      'vibgrate/dependency-major-lag': {
        id: 'vibgrate/dependency-major-lag',
        shortDescription: { text: 'Individual dependency severely behind' },
        helpUri: 'https://vibgrate.com/rules/dependency-major-lag',
      },
      'vibgrate/vulnerability': {
        id: 'vibgrate/vulnerability',
        shortDescription: { text: 'Known vulnerability in an installed dependency' },
        helpUri: 'https://vibgrate.com/rules/vulnerability',
      },
      'vibgrate/license-parse-failed': {
        id: 'vibgrate/license-parse-failed',
        shortDescription: { text: 'Declared license could not be resolved as SPDX' },
        helpUri: 'https://vibgrate.com/rules/license-parse-failed',
      },
    };
    return descriptions[id] ?? {
      id,
      shortDescription: { text: id },
      helpUri: 'https://vibgrate.com',
    };
  });
}

function suppressionKey(ruleId: string, location: string): string {
  return `${ruleId}\n${location}`;
}

/** rule+location → the audit record, so SARIF can cite the same id. */
function suppressionIndex(artifact: ScanArtifact): Map<string, BaselineSuppression> {
  const index = new Map<string, BaselineSuppression>();
  for (const entry of artifact.baselineComparison?.suppressed ?? []) {
    index.set(suppressionKey(entry.ruleId, entry.location), entry);
  }
  return index;
}

function toSarifResult(finding: Finding, suppression?: BaselineSuppression) {
  return {
    ruleId: finding.ruleId,
    level: finding.level === 'error' ? 'error' : finding.level === 'warning' ? 'warning' : 'note',
    message: { text: finding.message },
    locations: [
      {
        physicalLocation: {
          artifactLocation: {
            uri: finding.location,
          },
        },
      },
    ],
    // Content identity for code scanning. A baseline match keeps the
    // suppression id (rule + location). Every other drift result hashes the
    // finding, never the artifact timestamp or the result index.
    partialFingerprints: {
      [FINDING_FINGERPRINT_KEY]: suppression ? suppression.id : driftResultFingerprint(finding),
    },
    // Surface structured finding detail (e.g. advisory id, CVSS, fixed version)
    // to consumers like GitHub code scanning without bloating the message text.
    ...(finding.details && Object.keys(finding.details).length > 0 ? { properties: finding.details } : {}),
    // The result stays in the run. The suppression cites the same id as
    // `baselineComparison.suppressed`, so a baseline match is not dropped.
    ...(suppression
      ? {
          suppressions: [
            {
              kind: 'external',
              status: 'accepted',
              justification: 'Matches the drift baseline',
              properties: {
                id: suppression.id,
                ruleId: suppression.ruleId,
                location: suppression.location,
              },
            },
          ],
        }
      : {}),
  };
}

function encodePart(value: string): string {
  return `${Buffer.byteLength(value, 'utf8')}:${value}`;
}

function stringDetail(details: Finding['details'], key: string): string | undefined {
  const value = details?.[key];
  return typeof value === 'string' ? value : undefined;
}

function canonicalValue(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return `s:${value}`;
  if (typeof value === 'boolean') return `b:${value ? '1' : '0'}`;
  if (typeof value === 'number') return `n:${Number.isFinite(value) ? JSON.stringify(value) : ''}`;
  if (Array.isArray(value)) return `a:[${value.map(canonicalValue).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `o:{${keys.map((key) => encodePart(key) + canonicalValue(record[key])).join(',')}}`;
  }
  return '';
}

/** Sorted detail payload. Clock-derived keys are omitted. Object key order is ignored. */
function canonicalDetails(details: Finding['details']): string {
  if (!details) return '';
  const keys = Object.keys(details).filter((key) => !CLOCK_DETAIL_KEYS.has(key)).sort();
  return keys.map((key) => `${encodePart(key)}${encodePart(canonicalValue(details[key]))}`).join('\n');
}

/**
 * Content fingerprint for a drift result that is not baseline-suppressed.
 * 32 lowercase hex characters (128 bits of SHA-256). Parts are length-prefixed
 * so concatenation cannot collide. A vulnerability result is identified by
 * its package coordinates and advisory id, so a day count in the message
 * cannot move the value. Other results include the message, which is what
 * separates two frameworks or two packages that share a rule and a path.
 */
function driftResultFingerprint(finding: Finding): string {
  const parts = [
    encodePart('vg-sarif-result/v1'),
    encodePart(finding.ruleId),
    encodePart(finding.location),
  ];
  const advisoryId = stringDetail(finding.details, 'advisoryId');
  if (advisoryId) {
    parts.push(
      encodePart(stringDetail(finding.details, 'ecosystem') ?? ''),
      encodePart(stringDetail(finding.details, 'package') ?? ''),
      encodePart(stringDetail(finding.details, 'installedVersion') ?? ''),
      encodePart(advisoryId),
    );
  } else {
    parts.push(encodePart(finding.message));
    parts.push(encodePart(canonicalDetails(finding.details)));
  }
  return createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 32);
}
