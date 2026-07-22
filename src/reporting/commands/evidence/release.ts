// ── Freezing a shipped release into an immutable manifest ──
//
// The single biggest differentiator: the component manifest is frozen at ship
// time from what was actually shipped, and never regenerated. We build it from
// a scan artifact or an SBOM (CycloneDX/SPDX) captured at release.

import { readJsonFile, pathExists } from '../../utils/fs.js';
import { CliError, ExitCode } from '../../../util/exit.js';
import type { ProjectType, ScanArtifact } from '../../types.js';
import type { FrozenComponent, Release } from './types.js';

/** Map a Vibgrate project type to the OSV ecosystem used for advisory matching. */
export function ecosystemForProjectType(type: ProjectType): string | undefined {
  switch (type) {
    case 'node':
    case 'typescript':
      return 'npm';
    case 'python':
      return 'PyPI';
    case 'java':
    case 'kotlin':
    case 'scala':
    case 'groovy':
      return 'Maven';
    case 'dotnet':
    case 'visual-basic':
      return 'NuGet';
    case 'go':
      return 'Go';
    case 'rust':
      return 'crates.io';
    case 'ruby':
      return 'RubyGems';
    case 'php':
      return 'Packagist';
    case 'dart':
      return 'Pub';
    case 'elixir':
      return 'Hex';
    default:
      return undefined;
  }
}

function ecosystemForPurl(purl: string): string | undefined {
  const m = /^pkg:([^/]+)\//.exec(purl);
  if (!m) return undefined;
  const map: Record<string, string> = { npm: 'npm', pypi: 'PyPI', maven: 'Maven', nuget: 'NuGet', golang: 'Go', cargo: 'crates.io', gem: 'RubyGems', composer: 'Packagist', pub: 'Pub', hex: 'Hex' };
  return map[m[1].toLowerCase()];
}

export function componentsFromArtifact(artifact: ScanArtifact): FrozenComponent[] {
  const out: FrozenComponent[] = [];
  const seen = new Set<string>();
  for (const project of artifact.projects) {
    const ecosystem = ecosystemForProjectType(project.type);
    for (const dep of project.dependencies) {
      const version = dep.resolvedVersion ?? dep.currentSpec;
      const key = `${ecosystem ?? ''}|${dep.package}|${version}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ name: dep.package, version, ecosystem, purl: ecosystem === 'npm' ? `pkg:npm/${dep.package}@${version}` : undefined });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

interface CycloneDxComponent {
  name?: string;
  version?: string;
  purl?: string;
}
export function componentsFromCycloneDx(doc: { components?: CycloneDxComponent[] }): FrozenComponent[] {
  const out: FrozenComponent[] = [];
  for (const c of doc.components ?? []) {
    if (!c.name || !c.version) continue;
    out.push({ name: c.name, version: c.version, purl: c.purl, ecosystem: c.purl ? ecosystemForPurl(c.purl) : undefined });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

export interface FreezeInput {
  productId: string;
  version: string;
  from: string; // path to scan artifact or SBOM
  shipDate?: string;
  buildId?: string;
  artefactDigest?: string;
  distribution: string[];
  frozenAt: string;
}

/** Build (but do not persist) a frozen release manifest from a source file. */
export async function buildRelease(input: FreezeInput): Promise<Release> {
  if (!(await pathExists(input.from))) {
    throw new CliError(`source not found: ${input.from} — point --from at a scan artifact or SBOM`, ExitCode.NOT_FOUND);
  }
  const data = await readJsonFile<Record<string, unknown>>(input.from);
  let components: FrozenComponent[];
  if (data.bomFormat === 'CycloneDX' || Array.isArray(data.components)) {
    components = componentsFromCycloneDx(data as { components?: CycloneDxComponent[] });
  } else if (Array.isArray((data as unknown as ScanArtifact).projects)) {
    components = componentsFromArtifact(data as unknown as ScanArtifact);
  } else {
    throw new CliError(`unrecognised source format in ${input.from} — expected a Vibgrate scan artifact or a CycloneDX SBOM`, ExitCode.USAGE_ERROR);
  }
  if (components.length === 0) {
    throw new CliError(`no components found in ${input.from} — cannot freeze an empty manifest`, ExitCode.USAGE_ERROR);
  }
  return {
    productId: input.productId,
    version: input.version,
    shipDate: input.shipDate,
    buildId: input.buildId,
    artefactDigest: input.artefactDigest,
    manifestFormat: 'vibgrate-frozen-1',
    components,
    distribution: input.distribution,
    frozenAt: input.frozenAt,
  };
}
