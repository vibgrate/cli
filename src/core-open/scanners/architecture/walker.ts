// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import type { ArchitectureKnowledgePack } from './types.js';

/**
 * Frozen walker set from ARCHITECTURE-ENGINE-PLAN §7.
 * Packs may add extensions; they must never drop one of these.
 */
export const FROZEN_SOURCE_EXTENSIONS: readonly string[] = Object.freeze([
  '.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs', '.cts', '.cjs', '.svelte', '.vue',
  '.cs', '.vb', '.fs', '.cshtml', '.razor',
  '.java', '.kt', '.kts', '.scala', '.groovy',
  '.py', '.pyi',
  '.go', '.rs',
  '.rb', '.rake', '.erb',
  '.php',
  '.swift', '.dart',
  '.ex', '.exs', '.eex', '.heex',
]);

/** Contract filenames walked even when the extension is not in the source union. */
export const CONTRACT_BASENAMES: readonly string[] = Object.freeze([
  'openapi.yaml',
  'openapi.yml',
  'openapi.json',
  'swagger.yaml',
  'swagger.yml',
  'swagger.json',
  'asyncapi.yaml',
  'asyncapi.yml',
  'asyncapi.json',
]);

/**
 * Manifests we need for pack matching. Specific names only — never the
 * whole `.json` / `.xml` / `.toml` family (those include lockfiles).
 */
export const BUILD_BASENAMES: readonly string[] = Object.freeze([
  'package.json',
  'pom.xml',
  'go.mod',
  'pyproject.toml',
  'requirements.txt',
  'setup.py',
  'pipfile',
  'build.gradle',
  'build.gradle.kts',
  'settings.gradle',
  'settings.gradle.kts',
  'gemfile',
]);

const CONTRACT_BASENAME_SET = new Set(CONTRACT_BASENAMES);
const BUILD_BASENAME_SET = new Set(BUILD_BASENAMES);

export function isContractBasename(name: string): boolean {
  return CONTRACT_BASENAME_SET.has(name.toLowerCase());
}

export function isBuildBasename(name: string): boolean {
  return BUILD_BASENAME_SET.has(name.toLowerCase());
}

/** Union of the frozen walker and every pack's additive extensions. */
export function collectWalkExtensions(packs: readonly ArchitectureKnowledgePack[]): Set<string> {
  const set = new Set<string>(FROZEN_SOURCE_EXTENSIONS);
  for (const pack of packs) {
    for (const raw of pack.extensions ?? []) {
      const ext = raw.startsWith('.') ? raw.toLowerCase() : `.${raw.toLowerCase()}`;
      set.add(ext);
    }
  }
  return set;
}

const IAC_EXTENSIONS = new Set(['.tf', '.tfvars', '.hcl', '.bicep']);
const CONTRACT_EXTENSIONS = new Set(['.proto', '.graphql', '.gql', '.avsc']);

export function isIacExtension(ext: string): boolean {
  return IAC_EXTENSIONS.has(ext.toLowerCase());
}

export function isContractExtension(ext: string): boolean {
  return CONTRACT_EXTENSIONS.has(ext.toLowerCase());
}

export function isContractOrIacFile(filePath: string, basename: string): boolean {
  const ext = (() => {
    const i = filePath.lastIndexOf('.');
    return i >= 0 ? filePath.slice(i).toLowerCase() : '';
  })();
  return isIacExtension(ext) || isContractExtension(ext) || isContractBasename(basename);
}

const MANIFEST_EXTENSIONS = new Set(['.csproj', '.fsproj', '.vbproj', '.sln']);

/**
 * True for walked files that are not application source: build manifests,
 * contract/IaC definitions. Used so a proto repo with package.json is still
 * a dedicated contract tree (absent source ≠ those manifests).
 */
export function isApplicationSourceFile(filePath: string): boolean {
  const normalised = filePath.replace(/\\/g, '/');
  const slash = normalised.lastIndexOf('/');
  const name = slash >= 0 ? normalised.slice(slash + 1) : normalised;
  if (isBuildBasename(name)) return false;
  if (isContractOrIacFile(normalised, name)) return false;
  const ext = (() => {
    const i = name.lastIndexOf('.');
    return i >= 0 ? name.slice(i).toLowerCase() : '';
  })();
  if (MANIFEST_EXTENSIONS.has(ext)) return false;
  return true;
}

export function contractKindFromName(filePath: string, basename: string): string | undefined {
  const lower = basename.toLowerCase();
  const ext = (() => {
    const i = filePath.lastIndexOf('.');
    return i >= 0 ? filePath.slice(i).toLowerCase() : '';
  })();
  if (lower.startsWith('openapi') || lower.startsWith('swagger')) return 'openapi';
  if (lower.startsWith('asyncapi')) return 'asyncapi';
  if (ext === '.proto') return 'protobuf';
  if (ext === '.graphql' || ext === '.gql') return 'graphql';
  if (ext === '.avsc') return 'avro';
  return undefined;
}
