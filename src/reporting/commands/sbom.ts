import * as path from 'node:path';
import { Command } from 'commander';
import chalk from 'chalk';
import { pathExists, readJsonFile, writeTextFile } from '../utils/fs.js';
import type { DependencyRow, ScanArtifact } from '../types.js';
import { vexCommand } from './vex.js';

type SbomFormat = 'cyclonedx' | 'spdx';

interface FlattenedDependency {
  project: string;
  package: string;
  version: string;
  currentSpec: string;
  drift: DependencyRow['drift'];
  majorsBehind: number | null;
}

/**
 * Deterministic RFC 9562 version-8 UUID derived from `seed`, so an SBOM's
 * serialNumber / documentNamespace is stable for identical content instead of
 * random. A stable id makes `vg sbom export` reproducible for a given scan and
 * format. Uses a salted FNV-1a hash; a collision is only cosmetic — the SBOM
 * content, not this id, is what a consumer verifies.
 *
 * Kept in sync with the identical helper in the API
 * (`packages/vibgrate-api/src/lib/sbom-export.ts`).
 */
export function deterministicUuid(seed: string): string {
  const bytes = new Uint8Array(16);
  for (let block = 0; block < 4; block++) {
    let h = 0x811c9dc5;
    const s = `${block} ${seed}`;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    h >>>= 0;
    bytes[block * 4] = (h >>> 24) & 0xff;
    bytes[block * 4 + 1] = (h >>> 16) & 0xff;
    bytes[block * 4 + 2] = (h >>> 8) & 0xff;
    bytes[block * 4 + 3] = h & 0xff;
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x80; // version 8 (custom)
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10xx
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Stable seed for the document id: format + root + the ordered dependency set. */
function sbomSerialSeed(format: string, artifact: ScanArtifact, deps: FlattenedDependency[]): string {
  return [
    format,
    artifact.rootPath ?? '',
    artifact.timestamp ?? '',
    artifact.vibgrateVersion ?? '',
    ...deps.map((d) => `${d.package}|${d.version}|${d.currentSpec}|${d.project}|${d.drift}|${d.majorsBehind ?? ''}`),
  ].join('\n');
}

export function flattenDependencies(artifact: ScanArtifact): FlattenedDependency[] {
  const rows: FlattenedDependency[] = [];
  for (const project of artifact.projects) {
    for (const dep of project.dependencies) {
      rows.push({
        project: project.name,
        package: dep.package,
        version: dep.resolvedVersion ?? dep.currentSpec,
        currentSpec: dep.currentSpec,
        drift: dep.drift,
        majorsBehind: dep.majorsBehind,
      });
    }
  }
  return rows;
}

export function toCycloneDx(artifact: ScanArtifact): Record<string, unknown> {
  const dependencies = flattenDependencies(artifact);
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    serialNumber: `urn:uuid:${deterministicUuid(sbomSerialSeed('cyclonedx', artifact, dependencies))}`,
    version: 1,
    metadata: {
      timestamp: artifact.timestamp,
      tools: [
        {
          vendor: 'Vibgrate',
          name: '@vibgrate/cli',
          version: artifact.vibgrateVersion,
        },
      ],
      component: {
        type: 'application',
        name: artifact.rootPath,
      },
    },
    components: dependencies.map((dep) => ({
      type: 'library',
      name: dep.package,
      version: dep.version,
      properties: [
        { name: 'vibgrate:project', value: dep.project },
        { name: 'vibgrate:currentSpec', value: dep.currentSpec },
        { name: 'vibgrate:drift', value: dep.drift },
        { name: 'vibgrate:majorsBehind', value: String(dep.majorsBehind ?? 'unknown') },
      ],
    })),
  };
}

export function toSpdx(artifact: ScanArtifact): Record<string, unknown> {
  const dependencies = flattenDependencies(artifact);
  return {
    spdxVersion: 'SPDX-2.3',
    dataLicense: 'CC0-1.0',
    SPDXID: 'SPDXRef-DOCUMENT',
    name: `${artifact.rootPath}-sbom`,
    documentNamespace: `https://vibgrate.com/spdx/${artifact.rootPath}/${deterministicUuid(sbomSerialSeed('spdx', artifact, dependencies))}`,
    creationInfo: {
      created: artifact.timestamp,
      creators: [`Tool: @vibgrate/cli-${artifact.vibgrateVersion}`],
    },
    packages: dependencies.map((dep, i) => ({
      name: dep.package,
      SPDXID: `SPDXRef-Package-${i + 1}`,
      versionInfo: dep.version,
      downloadLocation: 'NOASSERTION',
      filesAnalyzed: false,
      externalRefs: [
        {
          referenceCategory: 'PACKAGE-MANAGER',
          referenceType: 'purl',
          referenceLocator: `pkg:npm/${encodeURIComponent(dep.package)}@${encodeURIComponent(dep.version)}`,
        },
      ],
      annotations: [
        {
          annotationType: 'OTHER',
          annotator: 'Tool: @vibgrate/cli',
          annotationDate: artifact.timestamp,
          comment: `project=${dep.project}; drift=${dep.drift}; majorsBehind=${dep.majorsBehind ?? 'unknown'}`,
        },
      ],
    })),
  };
}

function projectDependencyMap(artifact: ScanArtifact): Map<string, DependencyRow> {
  const map = new Map<string, DependencyRow>();
  for (const project of artifact.projects) {
    for (const dep of project.dependencies) {
      map.set(`${project.name}:${dep.package}`, dep);
    }
  }
  return map;
}

export function formatDeltaText(base: ScanArtifact, current: ScanArtifact): string {
  const baseMap = projectDependencyMap(base);
  const currentMap = projectDependencyMap(current);

  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];

  for (const [key, dep] of currentMap.entries()) {
    if (!baseMap.has(key)) {
      added.push(`${key} @ ${dep.resolvedVersion ?? dep.currentSpec}`);
      continue;
    }
    const prev = baseMap.get(key)!;
    const prevVersion = prev.resolvedVersion ?? prev.currentSpec;
    const nowVersion = dep.resolvedVersion ?? dep.currentSpec;
    if (prevVersion !== nowVersion || prev.majorsBehind !== dep.majorsBehind) {
      changed.push(`${key} ${prevVersion} -> ${nowVersion} (majorsBehind ${prev.majorsBehind ?? 'unknown'} -> ${dep.majorsBehind ?? 'unknown'})`);
    }
  }

  for (const [key, dep] of baseMap.entries()) {
    if (!currentMap.has(key)) {
      removed.push(`${key} @ ${dep.resolvedVersion ?? dep.currentSpec}`);
    }
  }

  const lines = [
    'Vibgrate SBOM Delta',
    '===================',
    `Baseline: ${base.timestamp}`,
    `Current:  ${current.timestamp}`,
    `DriftScore delta: ${(current.drift.score - base.drift.score).toFixed(2)} points`,
    '',
    `Added dependencies (${added.length})`,
    ...added.map((d) => `  + ${d}`),
    '',
    `Removed dependencies (${removed.length})`,
    ...removed.map((d) => `  - ${d}`),
    '',
    `Changed dependencies (${changed.length})`,
    ...changed.map((d) => `  * ${d}`),
  ];

  return lines.join('\n');
}

async function readArtifactOrExit(filePath: string): Promise<ScanArtifact> {
  const absolutePath = path.resolve(filePath);
  if (!(await pathExists(absolutePath))) {
    console.error(chalk.red(`Artifact not found: ${absolutePath}`));
    process.exit(1);
  }
  return readJsonFile<ScanArtifact>(absolutePath);
}

const exportCommand = new Command('export')
  .description('Export scan artifact as SBOM')
  .option('--in <file>', 'Input artifact file', '.vibgrate/scan_result.json')
  .option('--out <file>', 'Output SBOM file')
  .option('--format <format>', 'SBOM format (cyclonedx|spdx)', 'cyclonedx')
  .action(async (opts: { in: string; out?: string; format: string }) => {
    const artifact = await readArtifactOrExit(opts.in);
    const format = opts.format.toLowerCase() as SbomFormat;

    if (format !== 'cyclonedx' && format !== 'spdx') {
      console.error(chalk.red('Invalid SBOM format. Use cyclonedx or spdx.'));
      process.exit(1);
    }

    const sbom = format === 'cyclonedx' ? toCycloneDx(artifact) : toSpdx(artifact);
    const body = JSON.stringify(sbom, null, 2);

    if (opts.out) {
      await writeTextFile(path.resolve(opts.out), body);
      console.log(chalk.green('✔') + ` SBOM written to ${opts.out}`);
    } else {
      console.log(body);
    }
  });

const deltaCommand = new Command('delta')
  .description('Show SBOM delta between two scan artifacts')
  .requiredOption('--from <file>', 'Baseline scan artifact path')
  .requiredOption('--to <file>', 'Current scan artifact path')
  .option('--out <file>', 'Write report to file')
  .action(async (opts: { from: string; to: string; out?: string }) => {
    const base = await readArtifactOrExit(opts.from);
    const current = await readArtifactOrExit(opts.to);
    const report = formatDeltaText(base, current);

    if (opts.out) {
      await writeTextFile(path.resolve(opts.out), report);
      console.log(chalk.green('✔') + ` SBOM delta report written to ${opts.out}`);
    } else {
      console.log(report);
    }
  });

export const sbomCommand = new Command('sbom')
  .description('Supply-chain evidence: SBOM export/delta and OpenVEX generation')
  .addCommand(exportCommand)
  .addCommand(deltaCommand)
  .addCommand(vexCommand);
