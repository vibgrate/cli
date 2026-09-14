// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import type { ScanArtifact, Finding, SecurityFinding, SecuritySection, SecuritySeverity } from '../types.js';

/**
 * Generate a SARIF 2.1.0 document from scan artifact.
 *
 * The first run carries the drift findings and is byte-for-byte what it has
 * always been. When the artifact carries security-pack findings
 * (`extended.security`, from `vg scan --iac`), a second run is appended for
 * them — one run per artifact, with every pack listed under
 * `tool.extensions`, so a scan that ran no pack produces exactly the same
 * bytes as before.
 */
export function formatSarif(artifact: ScanArtifact): object {
  const rules = buildRules(artifact.findings);
  const results = artifact.findings.map((f) => toSarifResult(f));

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
    partialFingerprints: { 'vg/finding-id/v1': f.id },
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
    };
    return descriptions[id] ?? {
      id,
      shortDescription: { text: id },
      helpUri: 'https://vibgrate.com',
    };
  });
}

function toSarifResult(finding: Finding) {
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
    // Surface structured finding detail (e.g. advisory id, CVSS, fixed version)
    // to consumers like GitHub code scanning without bloating the message text.
    ...(finding.details && Object.keys(finding.details).length > 0 ? { properties: finding.details } : {}),
  };
}
