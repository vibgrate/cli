// Fail closed when an external SBOM is not the schema it claims to be.
//
// `vg evidence release --from` reads a CycloneDX or SPDX document (bare, or
// wrapped in an in-toto/DSSE attestation). A missing required field, a
// component that is not an object, or a file that is not JSON must not become
// a partial component list, an empty success, or a stack trace. The message
// names the file and the schema, says what to do next, and never echoes the
// document — SBOM fields can carry registry tokens.

import { portablePath } from '../../../core-open/utils/portable-path.js';
import { stripBom } from '../../utils/fs.js';
import { CliError, ExitCode } from '../../../util/exit.js';

export type ExternalSbomKind = 'cyclonedx' | 'spdx';

const ACTION =
  'Fix the document so it matches that schema, or pass a Vibgrate scan artifact to --from, then re-run the command.';

const EXPECTED = {
  CycloneDX:
    'Expected a CycloneDX JSON document with bomFormat "CycloneDX", specVersion, an integer version, and components that each have type and name.',
  SPDX:
    'Expected an SPDX 2.x JSON document with spdxVersion, dataLicense, SPDXID, name, documentNamespace, creationInfo, and packages that each have name, SPDXID, downloadLocation, filesAnalyzed, licenseConcluded, licenseDeclared, and copyrightText.',
  SBOM: 'Expected a CycloneDX or SPDX JSON document, or a Vibgrate scan artifact.',
} as const;

type SbomFormatName = keyof typeof EXPECTED;

/** Show a path without a `/home/…` or `/Users/…` prefix. */
export function displaySbomPath(filePath: string): string {
  return portablePath(filePath.replace(/\\/g, '/'));
}

/** Schema failure for an SBOM input. Exit code is usage (5); the message is stable. */
export class SbomInputError extends CliError {
  constructor(filePath: string, format: SbomFormatName, detail: string) {
    const title = format === 'SBOM' ? 'invalid SBOM' : `invalid ${format} SBOM`;
    super(`${displaySbomPath(filePath)}: ${title} — ${detail}. ${EXPECTED[format]} ${ACTION}`, ExitCode.USAGE_ERROR);
    this.name = 'SbomInputError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fail(label: string, format: SbomFormatName, detail: string): never {
  throw new SbomInputError(label, format, detail);
}

/**
 * Parse SBOM text. JSON syntax errors stay out of the message: Node's
 * `SyntaxError` quotes a slice of the file, and that slice can be a secret.
 */
export function parseExternalSbomJson(text: string, label: string): unknown {
  const body = stripBom(text);
  if (!body.trim()) fail(label, 'SBOM', 'the file is empty');
  try {
    return JSON.parse(body) as unknown;
  } catch {
    fail(label, 'SBOM', 'the file is not valid JSON');
  }
}

function missing(label: string, format: SbomFormatName, at: string, key: string): never {
  const where = at === '' ? 'missing required field' : `${at} is missing required field`;
  fail(label, format, `${where} "${key}"`);
}

function requireString(obj: Record<string, unknown>, key: string, at: string, label: string, format: SbomFormatName): string {
  if (!(key in obj) || obj[key] === undefined || obj[key] === null) missing(label, format, at, key);
  const value = obj[key];
  if (typeof value !== 'string' || value.trim() === '') {
    const where = at === '' ? `"${key}"` : `${at}.${key}`;
    fail(label, format, `${where} must be a non-empty string`);
  }
  return value;
}

function optionalString(obj: Record<string, unknown>, key: string, at: string, label: string, format: SbomFormatName): void {
  if (!(key in obj) || obj[key] === undefined) return;
  const value = obj[key];
  if (typeof value !== 'string' || value.trim() === '') {
    fail(label, format, `${at}.${key} must be a non-empty string`);
  }
}

/**
 * CycloneDX when `bomFormat` is set or `components` is present. SPDX when an
 * SPDX marker is set. Anything else is not an SBOM (a scan artifact, for
 * example) and the caller reports that separately.
 */
export function externalSbomKind(data: unknown): ExternalSbomKind | null {
  if (!isRecord(data)) return null;
  if ('bomFormat' in data && data.bomFormat !== undefined) return 'cyclonedx';
  if (typeof data.spdxVersion === 'string' || typeof data.SPDXID === 'string' || 'packages' in data) return 'spdx';
  if ('components' in data) return 'cyclonedx';
  return null;
}

/** Throw {@link SbomInputError} when `data` claims to be an SBOM and is not valid. */
export function assertExternalSbom(data: unknown, label: string): ExternalSbomKind | null {
  const kind = externalSbomKind(data);
  if (kind === 'cyclonedx') {
    assertCycloneDx(data, label);
    return kind;
  }
  if (kind === 'spdx') {
    assertSpdx(data, label);
    return kind;
  }
  return null;
}

function assertCycloneDx(data: unknown, label: string): void {
  if (!isRecord(data)) fail(label, 'CycloneDX', 'the document must be a JSON object');
  const bomFormat = requireString(data, 'bomFormat', '', label, 'CycloneDX');
  if (bomFormat !== 'CycloneDX') fail(label, 'CycloneDX', '"bomFormat" must be "CycloneDX"');
  const specVersion = requireString(data, 'specVersion', '', label, 'CycloneDX');
  if (!/^\d+\.\d+(?:\.\d+)?$/.test(specVersion)) {
    fail(label, 'CycloneDX', '"specVersion" must be a CycloneDX version such as "1.5"');
  }
  if (!('version' in data) || data.version === undefined || data.version === null) missing(label, 'CycloneDX', '', 'version');
  if (typeof data.version !== 'number' || !Number.isInteger(data.version) || data.version < 0) {
    fail(label, 'CycloneDX', '"version" must be an integer');
  }
  if (!('components' in data) || data.components === undefined) return;
  if (!Array.isArray(data.components)) fail(label, 'CycloneDX', 'components must be an array');
  for (let i = 0; i < data.components.length; i++) {
    const at = `components[${i}]`;
    const component = data.components[i];
    if (!isRecord(component)) fail(label, 'CycloneDX', `${at} must be an object`);
    requireString(component, 'type', at, label, 'CycloneDX');
    requireString(component, 'name', at, label, 'CycloneDX');
    optionalString(component, 'version', at, label, 'CycloneDX');
    optionalString(component, 'purl', at, label, 'CycloneDX');
  }
}

function assertSpdx(data: unknown, label: string): void {
  if (!isRecord(data)) fail(label, 'SPDX', 'the document must be a JSON object');
  const spdxVersion = requireString(data, 'spdxVersion', '', label, 'SPDX');
  if (!/^SPDX-2\.\d+$/.test(spdxVersion)) fail(label, 'SPDX', '"spdxVersion" must be an SPDX 2.x version such as "SPDX-2.3"');
  const dataLicense = requireString(data, 'dataLicense', '', label, 'SPDX');
  if (dataLicense !== 'CC0-1.0') fail(label, 'SPDX', '"dataLicense" must be "CC0-1.0"');
  const spdxId = requireString(data, 'SPDXID', '', label, 'SPDX');
  if (spdxId !== 'SPDXRef-DOCUMENT') fail(label, 'SPDX', '"SPDXID" must be "SPDXRef-DOCUMENT"');
  requireString(data, 'name', '', label, 'SPDX');
  requireString(data, 'documentNamespace', '', label, 'SPDX');
  if (!('creationInfo' in data) || data.creationInfo === undefined || data.creationInfo === null) {
    missing(label, 'SPDX', '', 'creationInfo');
  }
  if (!isRecord(data.creationInfo)) fail(label, 'SPDX', 'creationInfo must be an object');
  requireString(data.creationInfo, 'created', 'creationInfo', label, 'SPDX');
  if (!('creators' in data.creationInfo) || data.creationInfo.creators === undefined || data.creationInfo.creators === null) {
    missing(label, 'SPDX', 'creationInfo', 'creators');
  }
  if (!Array.isArray(data.creationInfo.creators) || data.creationInfo.creators.length === 0) {
    fail(label, 'SPDX', 'creationInfo.creators must be a non-empty array of strings');
  }
  for (let i = 0; i < data.creationInfo.creators.length; i++) {
    const creator = data.creationInfo.creators[i];
    if (typeof creator !== 'string' || creator.trim() === '') {
      fail(label, 'SPDX', `creationInfo.creators[${i}] must be a non-empty string`);
    }
  }
  if (!('packages' in data) || data.packages === undefined) return;
  if (!Array.isArray(data.packages)) fail(label, 'SPDX', 'packages must be an array');
  for (let i = 0; i < data.packages.length; i++) assertSpdxPackage(data.packages[i], i, label);
}

function assertSpdxPackage(value: unknown, index: number, label: string): void {
  const at = `packages[${index}]`;
  if (!isRecord(value)) fail(label, 'SPDX', `${at} must be an object`);
  requireString(value, 'name', at, label, 'SPDX');
  const spdxId = requireString(value, 'SPDXID', at, label, 'SPDX');
  if (!/^SPDXRef-[A-Za-z0-9.-]+$/.test(spdxId) || spdxId === 'SPDXRef-DOCUMENT') {
    fail(label, 'SPDX', `${at}.SPDXID must be an SPDXRef identifier`);
  }
  requireString(value, 'downloadLocation', at, label, 'SPDX');
  if (!('filesAnalyzed' in value) || value.filesAnalyzed === undefined || value.filesAnalyzed === null) {
    missing(label, 'SPDX', at, 'filesAnalyzed');
  }
  if (typeof value.filesAnalyzed !== 'boolean') fail(label, 'SPDX', `${at}.filesAnalyzed must be a boolean`);
  requireString(value, 'licenseConcluded', at, label, 'SPDX');
  requireString(value, 'licenseDeclared', at, label, 'SPDX');
  requireString(value, 'copyrightText', at, label, 'SPDX');
  if (value.filesAnalyzed !== false) {
    if (!Array.isArray(value.licenseInfoFromFiles)) {
      fail(label, 'SPDX', `${at}.licenseInfoFromFiles must be an array when filesAnalyzed is not false`);
    }
    if (!Array.isArray(value.checksums)) {
      fail(label, 'SPDX', `${at}.checksums must be an array when filesAnalyzed is not false`);
    }
  }
  optionalString(value, 'versionInfo', at, label, 'SPDX');
  if (!('externalRefs' in value) || value.externalRefs === undefined) return;
  if (!Array.isArray(value.externalRefs)) fail(label, 'SPDX', `${at}.externalRefs must be an array`);
  for (let i = 0; i < value.externalRefs.length; i++) {
    if (!isRecord(value.externalRefs[i])) fail(label, 'SPDX', `${at}.externalRefs[${i}] must be an object`);
  }
}
