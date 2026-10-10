/**
 * Child entry for the locale-output test. Prints one JSON object on stdout.
 * Scan logs go to stderr so the parent can compare stdout bytes.
 */
import { runCoreScan } from '../src/core-open/index.js';
import { formatSarif } from '../src/core-open/formatters/sarif.js';
import { generateFindings } from '../src/core-open/scoring/drift-score.js';
import type { DependencyLicense, ProjectScan, ScanArtifact } from '../src/core-open/types.js';
import { toCycloneDx } from '../src/reporting/commands/sbom.js';

const root = process.argv[2];
if (!root) {
  console.error('usage: locale-output-emit.ts <fixture>');
  process.exit(2);
}

const realLog = console.log.bind(console);
console.log = (...args: unknown[]) => {
  console.error(...args);
};

const artifact = await runCoreScan(root, {
  format: 'text',
  offline: true,
  noLocalArtifacts: true,
  quiet: true,
  concurrency: 2,
  vibgrateVersion: 'test',
});

const rootProject = artifact.projects.find((project) => project.name === 'root-app');
if (!rootProject) {
  console.error('root-app project missing');
  process.exit(1);
}

const badLicense: DependencyLicense = {
  raw: 'NOT-A-LICENSE',
  spdxId: null,
  source: 'registry',
  confidence: 0,
};

const licensed: ProjectScan = {
  ...rootProject,
  dependencies: rootProject.dependencies.map((dep) => ({ ...dep, license: badLicense })),
};

const findings = generateFindings([licensed]);
const sarifArtifact: ScanArtifact = {
  ...artifact,
  timestamp: '2020-01-01T00:00:00.000Z',
  findings,
};
const sarif = formatSarif(sarifArtifact, root) as {
  runs: Array<{ results: Array<{ message: { text: string } }> }>;
};

const cdx = toCycloneDx(artifact);
const components = ((cdx.components as Array<Record<string, unknown>> | undefined) ?? []).map((component) => {
  const properties = (component.properties as Array<{ name: string; value: string }> | undefined) ?? [];
  const projects = properties.find((property) => property.name === 'vibgrate:projects')?.value ?? '';
  return { name: component.name, projects };
});

realLog(JSON.stringify({
  dependencyNames: rootProject.dependencies.map((dep) => dep.package),
  sarifMessages: sarif.runs[0]?.results.map((result) => result.message.text) ?? [],
  components,
}));
