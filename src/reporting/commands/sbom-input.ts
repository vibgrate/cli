// Fail closed when an external SPDX or CycloneDX document is not usable.
//
// `vg evidence release --from` (and an SBOM attached to an inspected image)
// consumes that document and merges its components into a frozen manifest.
// A truncated file, invalid JSON, or a document missing a required field must
// exit non-zero with the path, the format that was expected, and what to do
// next. The message never includes document bytes — an SBOM can carry registry
// tokens — and it never includes a home-directory prefix.

import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { CliError, ExitCode } from '../../util/exit.js';
import { stripBom } from '../utils/fs.js';

const REGENERATE = 'Regenerate the SBOM, then re-run the command.';

const CYCLONE_EXPECT = 'Expected CycloneDX JSON with bomFormat, specVersion, and version.';
const SPDX_EXPECT = 'Expected SPDX JSON with spdxVersion, SPDXID, and name.';
const EITHER_EXPECT =
  'Expected CycloneDX JSON (bomFormat, specVersion, and version) or SPDX JSON (spdxVersion, SPDXID, and name).';

/** `SPDX-2.3`. SPDX document versions are `SPDX-<major>.<minor>`. */
const SPDX_VERSION = /^SPDX-\d+\.\d+$/;
/** CycloneDX `specVersion`, such as `1.5` or `1.6`. */
const CYCLONE_SPEC = /^\d+\.\d+(?:\.\d+)?$/;

/**
 * `/home/<account>/…` or `/Users/<account>/…`, including a Windows drive
 * prefix. The account segment is not echoed.
 */
const HOME_DIR = /^(?:[A-Za-z]:)?\/(?:home|Users)\/[^/]+\/(.*)$/;

/**
 * An external SBOM cannot be consumed.
 *
 * `corrupt` is truncated or invalid JSON, or a file that could not be read.
 * `schema` is a CycloneDX or SPDX document missing a required field. `code`
 * is {@link ExitCode.ERROR} so the command exits non-zero. The same bytes
 * always produce the same message.
 */
export class SbomInputError extends CliError {
  readonly isSbomInputError = true;
  readonly kind: 'corrupt' | 'schema';

  constructor(message: string, kind: 'corrupt' | 'schema') {
    super(message, ExitCode.ERROR);
    this.name = 'SbomInputError';
    this.kind = kind;
  }
}

/**
 * Path named in an error. A home-directory prefix is dropped so the message
 * does not reveal the account. A relative path, or a path outside `/home` and
 * `/Users`, is returned unchanged.
 */
export function sbomDisplayPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const match = HOME_DIR.exec(normalized);
  if (!match) return filePath;
  return match[1] || path.posix.basename(normalized);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Whether `data` is attempting to be a CycloneDX or SPDX document. */
export function externalSbomKind(data: unknown): 'cyclonedx' | 'spdx' | 'other' {
  if (!isRecord(data)) return 'other';
  if (data.bomFormat === 'CycloneDX') return 'cyclonedx';
  if (typeof data.spdxVersion === 'string' || typeof data.SPDXID === 'string' || Array.isArray(data.packages)) {
    return 'spdx';
  }
  if (typeof data.bomFormat === 'string' || typeof data.specVersion === 'string' || Array.isArray(data.components)) {
    return 'cyclonedx';
  }
  return 'other';
}

function corruptMessage(label: string): string {
  return `${label}: truncated or not valid JSON. ${EITHER_EXPECT} ${REGENERATE}`;
}

function schemaMessage(label: string, format: 'CycloneDX' | 'SPDX', reason: string, expected: string): string {
  return `${label}: not a valid ${format} document (${reason}). ${expected} ${REGENERATE}`;
}

function cyclonedxProblem(doc: Record<string, unknown>): string | undefined {
  if (doc.bomFormat !== 'CycloneDX') {
    return typeof doc.bomFormat === 'string' ? 'bomFormat must be CycloneDX' : 'missing bomFormat';
  }
  if (typeof doc.specVersion !== 'string' || doc.specVersion.trim() === '') return 'missing specVersion';
  if (!CYCLONE_SPEC.test(doc.specVersion)) return 'specVersion must be a version such as 1.5';
  if (!Object.prototype.hasOwnProperty.call(doc, 'version')) return 'missing version';
  if (typeof doc.version !== 'number' || !Number.isInteger(doc.version) || doc.version < 0) {
    return 'version must be an integer';
  }
  if (!Object.prototype.hasOwnProperty.call(doc, 'components')) return undefined;
  if (!Array.isArray(doc.components)) return 'components must be an array';
  for (let i = 0; i < doc.components.length; i++) {
    const problem = componentNameProblem(doc.components[i], `component ${i + 1}`);
    if (problem) return problem;
  }
  return undefined;
}

function spdxProblem(doc: Record<string, unknown>): string | undefined {
  if (typeof doc.spdxVersion !== 'string' || doc.spdxVersion.trim() === '') return 'missing spdxVersion';
  if (!SPDX_VERSION.test(doc.spdxVersion)) return 'spdxVersion must be an SPDX version such as SPDX-2.3';
  if (!Object.prototype.hasOwnProperty.call(doc, 'SPDXID')) return 'missing SPDXID';
  if (doc.SPDXID !== 'SPDXRef-DOCUMENT') return 'SPDXID must be SPDXRef-DOCUMENT';
  if (!Object.prototype.hasOwnProperty.call(doc, 'name')) return 'missing name';
  if (typeof doc.name !== 'string') return 'name must be a string';
  if (doc.name.trim() === '') return 'missing name';
  if (!Object.prototype.hasOwnProperty.call(doc, 'packages')) return undefined;
  if (!Array.isArray(doc.packages)) return 'packages must be an array';
  for (let i = 0; i < doc.packages.length; i++) {
    const problem = componentNameProblem(doc.packages[i], `package ${i + 1}`);
    if (problem) return problem;
  }
  return undefined;
}

/** Required `name` on a component or package. Does not read any other field. */
function componentNameProblem(value: unknown, where: string): string | undefined {
  if (!isRecord(value)) return `${where} must be an object`;
  if (!Object.prototype.hasOwnProperty.call(value, 'name')) return `${where} is missing name`;
  if (typeof value.name !== 'string') return `${where} name must be a string`;
  if (value.name.trim() === '') return `${where} is missing name`;
  return undefined;
}

/**
 * Accept a CycloneDX or SPDX document, or throw {@link SbomInputError}.
 *
 * Checks the fields those formats require at the top of the document, and
 * that every component or package is an object with a `name`. A missing
 * `name` fails the document; the component is not dropped. `version` stays
 * optional, matching both specs. Returns which format was accepted.
 */
export function assertExternalSbom(data: unknown, label: string): 'cyclonedx' | 'spdx' {
  const shown = sbomDisplayPath(label);
  const kind = externalSbomKind(data);
  if (kind === 'other' || !isRecord(data)) {
    throw new SbomInputError(
      `${shown}: not a CycloneDX or SPDX document. ${CYCLONE_EXPECT} ${SPDX_EXPECT} ${REGENERATE}`,
      'schema',
    );
  }
  if (kind === 'cyclonedx') {
    const reason = cyclonedxProblem(data);
    if (reason) throw new SbomInputError(schemaMessage(shown, 'CycloneDX', reason, CYCLONE_EXPECT), 'schema');
    return 'cyclonedx';
  }
  const reason = spdxProblem(data);
  if (reason) throw new SbomInputError(schemaMessage(shown, 'SPDX', reason, SPDX_EXPECT), 'schema');
  return 'spdx';
}

/**
 * Parse SBOM text. Throws {@link SbomInputError} on empty, truncated, or
 * invalid JSON. The parser's own message is discarded so a snippet of the
 * file cannot reach the operator.
 */
export function parseSbomJson(text: string, label: string): unknown {
  const shown = sbomDisplayPath(label);
  const body = stripBom(text);
  if (!body.trim()) throw new SbomInputError(corruptMessage(shown), 'corrupt');
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new SbomInputError(corruptMessage(shown), 'corrupt');
  }
}

/**
 * Read an SBOM file that is known to exist. A read or parse failure throws
 * {@link SbomInputError}. Absence is the caller's concern.
 */
export async function readSbomJsonFile(filePath: string): Promise<unknown> {
  const shown = sbomDisplayPath(filePath);
  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch {
    throw new SbomInputError(
      `${shown}: could not be read. Check that the file is accessible, then re-run the command.`,
      'corrupt',
    );
  }
  return parseSbomJson(text, shown);
}
