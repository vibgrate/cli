// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import { createHash } from 'node:crypto';
import { baselineSuppressionId } from '../baseline-suppressions.js';
import type { BaselineSuppression, ScanArtifact, Finding, SecurityFinding, SecuritySection, SecuritySeverity } from '../types.js';
import { redactHomePaths } from '../utils/shareable-path.js';

/**
 * SARIF `partialFingerprints` key for every result `vg scan` emits.
 * The value is a content id. It is never a result index, a clock, or the
 * artifact timestamp.
 */
const FINDING_FINGERPRINT_KEY = 'vg/finding-id/v1';

/**
 * Generate a SARIF 2.1.0 document from scan artifact.
 *
 * The first run is the drift findings. Every result in it carries
 * `partialFingerprints["vg/finding-id/v1"]`. When the artifact carries
 * security-pack findings (`extended.security`, from `vg scan --iac`), a
 * second run is appended for them — one run per artifact, with every pack
 * listed under `tool.extensions`. A scan that ran no pack is still one run,
 * and an empty pack section does not change the document.
 */
export function formatSarif(artifact: ScanArtifact, root?: string): object {
  // Fingerprints and baseline ids use the location, so rewrite home paths
  // before either is computed. A second pass sees only relative or `~/` paths.
  artifact = redactHomePaths(artifact, root);
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

/** Detail fields that identify a finding. Scores, aliases, and versions are not identity. */
const IDENTITY_DETAIL_KEYS = ['advisoryId', 'ecosystem', 'package', 'purl', 'raw'] as const;

/**
 * Rules that can emit more than one finding at the same path, with the
 * subject named only in the message: `<name> is <n> major versions behind`.
 * The name is stable when the count or the latest version changes.
 */
const LAG_SUBJECT_RULES = new Set([
  'vibgrate/dependency-major-lag',
  'vibgrate/framework-major-lag',
]);

/** License failures name the package only in the message. */
const LICENSE_PARSE_FAILED_RULE = 'vibgrate/license-parse-failed';

const LAG_SUBJECT = /^(.*) is \d+ major versions behind\b/;

function identityDetail(details: Finding['details'], key: string): string | null {
  const value = details?.[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function lagSubject(message: string): string | null {
  const subject = LAG_SUBJECT.exec(message)?.[1]?.trim() ?? '';
  return subject.length > 0 ? subject : null;
}

function hashFingerprint(parts: readonly string[]): string {
  const input = parts.map((part) => `${part.length}\n${part}`).join('\n');
  return createHash('sha256').update(input).digest('hex').slice(0, 32);
}

/**
 * Content id for a drift or vulnerability result that is not baseline-suppressed.
 *
 * Rule and location are always included. Advisory id, ecosystem, package name,
 * package URL, and declared license text are included when the finding carries
 * them. Major-lag findings add the package or framework name from the message.
 * License findings add the message, which names the package. Anything else
 * (the scan clock, result order, severity, CVSS, aliases, installed version)
 * is left out, so a refreshed wording of the same finding keeps the id.
 *
 * A finding with no extra identity uses {@link baselineSuppressionId}, so the
 * fingerprint matches the id `--baseline` will record for that rule and location.
 */
function driftResultFingerprint(finding: Finding): string {
  const extras: string[] = [];
  for (const key of IDENTITY_DETAIL_KEYS) {
    const value = identityDetail(finding.details, key);
    if (value) extras.push(key, value);
  }
  if (LAG_SUBJECT_RULES.has(finding.ruleId)) {
    extras.push('subject', lagSubject(finding.message) ?? finding.message);
  } else if (finding.ruleId === LICENSE_PARSE_FAILED_RULE) {
    extras.push('message', finding.message);
  }
  if (extras.length === 0) return baselineSuppressionId(finding.ruleId, finding.location);
  return hashFingerprint(['vg-sarif-partial/v1', finding.ruleId, finding.location, ...extras]);
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
    // Content-stable across runs. A baseline match keeps the suppression id
    // (`vg/finding-id/v1` already meant that). Every other result gets an id
    // from the finding itself, not from order or the artifact clock.
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
