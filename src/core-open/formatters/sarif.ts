// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import type { ScanArtifact, Finding } from '../types.js';

/** Generate a SARIF 2.1.0 document from scan artifact */
export function formatSarif(artifact: ScanArtifact): object {
  const rules = buildRules(artifact.findings);
  const results = artifact.findings.map((f) => toSarifResult(f));

  return {
    $schema: 'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json',
    version: '2.1.0',
    runs: [
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
  };
}
