/**
 * Local vulnerable-symbol reachability analysis.
 *
 * Matches the risky-symbol manifest (from `POST /v1/ingest/scan/preflight/symbols`)
 * against the LOCAL code map (`vg` graph): is the vulnerable package imported
 * anywhere, and is any of its vulnerable symbols referenced from an importing
 * file? Source never leaves the machine — only the tier verdicts and the
 * module-import evidence are attached to the scan artifact.
 *
 * Tier semantics (kept deliberately conservative — precision only ever
 * resolves UP toward "reachable", never down):
 *   - reachable              — the package is imported AND a vulnerable symbol is
 *                              referenced in an importing file (lexical match,
 *                              confidence-scaled; dynamic access can't be ruled in
 *                              or out, hence < 1.0 confidence).
 *   - potentially_reachable  — the package is imported but the symbols could not
 *                              be resolved (no symbol data, or names too generic
 *                              to match safely).
 *   - not_reached            — the package appears in no import in the code map
 *                              (or none of its vulnerable symbols is referenced).
 *   - unknown                — no code map, or an ecosystem the import matcher
 *                              does not support. Inert in scoring: unknown ≠ safe.
 */

import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import type {
  ScanReachabilityResult,
  ScanReachabilityFinding,
  ReachabilityTier,
  RiskySymbolManifestEntry,
  SymbolsPreflightDependency,
} from '../core-open/index.js';
import type { VgGraph, GraphNode } from '../schema.js';
import { indexFor } from '../engine/relations.js';

export const REACHABILITY_ANALYZER_VERSION = 'vg-reach-1.0';

/** Base confidence of the per-ecosystem import matcher (specifier ↔ package). */
const ECOSYSTEM_MATCH_CONFIDENCE: Record<string, number> = {
  npm: 0.8,
  Go: 0.8,
  'crates.io': 0.7,
  PyPI: 0.65,
  RubyGems: 0.6,
};

/** Symbol names too generic for a lexical match to mean anything. */
const GENERIC_SYMBOL_NAMES = new Set([
  'get', 'set', 'run', 'main', 'init', 'call', 'apply', 'exec', 'send', 'open',
  'read', 'write', 'parse', 'load', 'save', 'start', 'stop', 'new', 'create',
  'update', 'delete', 'handle', 'process', 'render', 'value', 'data', 'next',
]);

const MAX_FILES_PER_PACKAGE = 25;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_MODULES_PER_PACKAGE = 50;
const MAX_IMPORTED_MODULE_PACKAGES = 500;
const MAX_FINDINGS = 1000;

interface PackageImportEvidence {
  /** Whether the matcher supports this ecosystem at all. */
  supported: boolean;
  /** Matched import specifiers (external node names). */
  modules: string[];
  /** Repo-relative paths of files importing the package. */
  importingFiles: string[];
}

function normalizePython(name: string): string {
  return name.toLowerCase().replace(/[-.]/g, '_');
}

/** Does this import specifier belong to the given package, per ecosystem rules? */
export function specifierMatchesPackage(ecosystem: string, pkg: string, spec: string): boolean {
  switch (ecosystem) {
    case 'npm':
    case 'Go':
    case 'RubyGems':
      return spec === pkg || spec.startsWith(`${pkg}/`);
    case 'PyPI': {
      const top = spec.split('.')[0] ?? spec;
      return normalizePython(top) === normalizePython(pkg);
    }
    case 'crates.io': {
      const top = (spec.split('::')[0] ?? spec).toLowerCase().replace(/-/g, '_');
      return top === pkg.toLowerCase().replace(/-/g, '_');
    }
    default:
      return false;
  }
}

/** The identifier a lexical reference to a vulnerable symbol would use. */
export function symbolIdentifier(symbol: string): string {
  const cleaned = symbol.replace(/\(.*\)$/, '');
  const segments = cleaned.split(/[./:#]|::/).filter(Boolean);
  return segments[segments.length - 1] ?? cleaned;
}

/** Whether a lexical match on this identifier is meaningful evidence. */
export function isMatchableIdentifier(identifier: string): boolean {
  return identifier.length >= 3 && !GENERIC_SYMBOL_NAMES.has(identifier.toLowerCase());
}

/** Collect import evidence for one package from the graph's external nodes. */
function collectPackageImports(
  graph: VgGraph,
  ecosystem: string,
  pkg: string,
): PackageImportEvidence {
  if (!(ecosystem in ECOSYSTEM_MATCH_CONFIDENCE)) {
    return { supported: false, modules: [], importingFiles: [] };
  }
  const idx = indexFor(graph);
  const modules = new Set<string>();
  const files = new Set<string>();
  for (const node of graph.nodes) {
    if (node.kind !== 'external') continue;
    if (!specifierMatchesPackage(ecosystem, pkg, node.name)) continue;
    modules.add(node.name);
    for (const edge of idx.in(node.id, 'import')) {
      const src = idx.nodeById.get(edge.src) as GraphNode | undefined;
      if (src?.file) files.add(src.file);
    }
  }
  return {
    supported: true,
    modules: [...modules].sort(),
    importingFiles: [...files].sort(),
  };
}

async function fileReferencesIdentifier(
  rootDir: string,
  relFile: string,
  identifier: string,
  readFile: (absPath: string) => Promise<string | null>,
): Promise<boolean> {
  const content = await readFile(path.join(rootDir, relFile));
  if (!content) return false;
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`).test(content);
}

async function defaultReadFile(absPath: string): Promise<string | null> {
  try {
    const stat = await fs.stat(absPath);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
    return await fs.readFile(absPath, 'utf8');
  } catch {
    return null;
  }
}

export interface ReachabilityAnalysisInput {
  /** The freshly built code map; null when unavailable (all findings Unknown). */
  graph: VgGraph | null;
  rootDir: string;
  /** Risky-symbol manifest from the symbols preflight. */
  manifest: RiskySymbolManifestEntry[];
  /** The dependency coordinates that were posted (for module-import evidence). */
  dependencies: SymbolsPreflightDependency[];
  /** Injectable for tests. */
  readFile?: (absPath: string) => Promise<string | null>;
}

/**
 * Run the local reachability query. Never throws for per-file problems; a
 * missing/unreadable file simply yields no lexical evidence.
 */
export async function analyzeReachability(
  input: ReachabilityAnalysisInput,
): Promise<ScanReachabilityResult> {
  const generatedAt = new Date().toISOString();
  const readFile = input.readFile ?? defaultReadFile;

  if (!input.graph) {
    return {
      analyzerVersion: REACHABILITY_ANALYZER_VERSION,
      source: 'none',
      generatedAt,
      manifestAdvisoryCount: input.manifest.length,
      findings: input.manifest.slice(0, MAX_FINDINGS).map((entry) => ({
        advisoryId: entry.advisoryId,
        ecosystem: entry.ecosystem,
        package: entry.package,
        version: entry.version,
        tier: 'unknown' as ReachabilityTier,
        evidence: 'no code map available for this scan',
        graphConfidence: 0,
      })),
    };
  }

  // Module-import evidence for every posted dependency in a supported
  // ecosystem — including "looked, found no import" (importingFiles: 0), which
  // the server needs to distinguish from "never evaluated" (entry absent).
  const evidenceByPackage = new Map<string, PackageImportEvidence>();
  const importedModules: NonNullable<ScanReachabilityResult['importedModules']> = [];
  const seenPackages = new Set<string>();
  for (const dep of input.dependencies) {
    const key = `${dep.ecosystem}|${dep.package}`;
    if (seenPackages.has(key)) continue;
    seenPackages.add(key);
    const evidence = collectPackageImports(input.graph, dep.ecosystem, dep.package);
    evidenceByPackage.set(key, evidence);
    if (evidence.supported && importedModules.length < MAX_IMPORTED_MODULE_PACKAGES) {
      importedModules.push({
        ecosystem: dep.ecosystem,
        package: dep.package,
        modules: evidence.modules.slice(0, MAX_MODULES_PER_PACKAGE),
        importingFiles: evidence.importingFiles.length,
      });
    }
  }
  importedModules.sort(
    (a, b) => a.ecosystem.localeCompare(b.ecosystem) || a.package.localeCompare(b.package),
  );

  const findings: ScanReachabilityFinding[] = [];

  for (const entry of input.manifest) {
    const key = `${entry.ecosystem}|${entry.package}`;
    const evidence =
      evidenceByPackage.get(key) ?? collectPackageImports(input.graph, entry.ecosystem, entry.package);
    const baseConfidence = ECOSYSTEM_MATCH_CONFIDENCE[entry.ecosystem] ?? 0;

    if (!evidence.supported) {
      findings.push({
        advisoryId: entry.advisoryId,
        ecosystem: entry.ecosystem,
        package: entry.package,
        version: entry.version,
        tier: 'unknown',
        evidence: `import matching is not supported for the ${entry.ecosystem} ecosystem yet`,
        graphConfidence: 0,
      });
      continue;
    }

    if (evidence.importingFiles.length === 0) {
      findings.push({
        advisoryId: entry.advisoryId,
        ecosystem: entry.ecosystem,
        package: entry.package,
        version: entry.version,
        tier: 'not_reached',
        evidence: `no import of ${entry.package} was found in the code map`,
        graphConfidence: baseConfidence,
      });
      continue;
    }

    const matchableSymbols = entry.symbols
      .map((s) => ({ symbol: s.symbol, identifier: symbolIdentifier(s.symbol) }))
      .filter((s) => isMatchableIdentifier(s.identifier));

    if (entry.symbolCoverage !== 'function' || matchableSymbols.length === 0) {
      // Module imported, but no usable symbol data (pending extraction, module
      // coverage, or names too generic to match safely) → potentially reachable.
      findings.push({
        advisoryId: entry.advisoryId,
        ecosystem: entry.ecosystem,
        package: entry.package,
        version: entry.version,
        tier: 'potentially_reachable',
        evidence: `${entry.package} is imported by ${evidence.importingFiles.length} file${evidence.importingFiles.length === 1 ? '' : 's'}; vulnerable symbols unresolved (coverage: ${entry.symbolCoverage})`,
        callPath: evidence.importingFiles.slice(0, 10),
        graphConfidence: Math.min(baseConfidence, 0.6),
      });
      continue;
    }

    // Symbol-level check: lexical reference to any vulnerable symbol in an
    // importing file. Bounded fan-out so huge repos stay fast.
    const filesToCheck = evidence.importingFiles.slice(0, MAX_FILES_PER_PACKAGE);
    let anySymbolFound = false;
    for (const { symbol, identifier } of matchableSymbols) {
      const referencingFiles: string[] = [];
      for (const relFile of filesToCheck) {
        if (await fileReferencesIdentifier(input.rootDir, relFile, identifier, readFile)) {
          referencingFiles.push(relFile);
          if (referencingFiles.length >= 5) break;
        }
      }
      if (referencingFiles.length > 0) {
        anySymbolFound = true;
        findings.push({
          advisoryId: entry.advisoryId,
          ecosystem: entry.ecosystem,
          package: entry.package,
          version: entry.version,
          symbol,
          tier: 'reachable',
          evidence: `vulnerable symbol \`${identifier}\` is referenced in ${referencingFiles.length} importing file${referencingFiles.length === 1 ? '' : 's'}`,
          callPath: referencingFiles,
          graphConfidence: Math.min(baseConfidence, 0.75),
        });
      }
    }

    if (!anySymbolFound) {
      findings.push({
        advisoryId: entry.advisoryId,
        ecosystem: entry.ecosystem,
        package: entry.package,
        version: entry.version,
        tier: 'not_reached',
        evidence: `${entry.package} is imported, but none of its ${matchableSymbols.length} vulnerable symbol${matchableSymbols.length === 1 ? '' : 's'} is referenced in the ${filesToCheck.length} importing file${filesToCheck.length === 1 ? '' : 's'} checked`,
        callPath: evidence.importingFiles.slice(0, 10),
        graphConfidence: Math.min(baseConfidence, 0.55),
      });
    }
  }

  findings.sort(
    (a, b) =>
      a.ecosystem.localeCompare(b.ecosystem) ||
      a.package.localeCompare(b.package) ||
      a.advisoryId.localeCompare(b.advisoryId) ||
      (a.symbol ?? '').localeCompare(b.symbol ?? ''),
  );

  return {
    analyzerVersion: REACHABILITY_ANALYZER_VERSION,
    source: 'graph',
    generatedAt,
    manifestAdvisoryCount: input.manifest.length,
    importedModules,
    findings: findings.slice(0, MAX_FINDINGS),
  };
}

/**
 * Collect the deduped dependency coordinates to post to the symbols preflight
 * from the scan artifact's per-project dependency rows.
 */
export function collectPreflightDependencies(
  projects: Array<{
    type: string;
    dependencies: Array<{ package: string; resolvedVersion: string | null; currentSpec: string }>;
  }>,
  projectTypeToEcosystem: Partial<Record<string, string>>,
): SymbolsPreflightDependency[] {
  const deduped = new Map<string, SymbolsPreflightDependency>();
  for (const project of projects) {
    const ecosystem = projectTypeToEcosystem[project.type];
    if (!ecosystem) continue;
    for (const dep of project.dependencies) {
      const version = dep.resolvedVersion || normalizeVersionSpec(dep.currentSpec);
      if (!version) continue;
      const key = `${ecosystem}:${dep.package}:${version}`;
      if (!deduped.has(key)) {
        deduped.set(key, { ecosystem, package: dep.package, version });
      }
    }
  }
  return [...deduped.values()].sort(
    (a, b) =>
      a.ecosystem.localeCompare(b.ecosystem) ||
      a.package.localeCompare(b.package) ||
      a.version.localeCompare(b.version),
  );
}

function normalizeVersionSpec(spec: string): string | null {
  const match = spec.trim().match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/);
  return match?.[0] ?? null;
}
