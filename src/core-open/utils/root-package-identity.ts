// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { stripBom } from './fs.js';

/**
 * Identity of the root package when `package.json` omits `name`, `version`,
 * or both.
 *
 * The fallback name is the directory's last segment. It is never an absolute
 * path, so the same tree produces the same name on every machine. A missing
 * version stays omitted. Callers do not invent `0.0.0`.
 */

/** Last path segment. `.`, `..`, and an empty basename become `unnamed`. */
export function directoryFallbackName(rootDir: string): string {
  const base = path.basename(path.resolve(rootDir));
  if (!base || base === '.' || base === '..') return 'unnamed';
  return base;
}

/** A manifest field counts only when it is a non-empty string. */
export function nonEmptyManifestString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export interface RootPackageIdentity {
  /** True when the root `package.json` parsed as a JSON object. */
  present: boolean;
  /** Declared name, or the directory name when `name` is missing. */
  name: string;
  /** Declared version, or null when `version` is missing. */
  version: string | null;
  missingName: boolean;
  missingVersion: boolean;
}

export function readRootPackageIdentity(rootDir: string): RootPackageIdentity {
  const fallbackName = directoryFallbackName(rootDir);
  const absent: RootPackageIdentity = {
    present: false,
    name: fallbackName,
    version: null,
    missingName: false,
    missingVersion: false,
  };
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8');
  } catch {
    return absent;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripBom(raw));
  } catch {
    return absent;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return absent;
  const record = parsed as Record<string, unknown>;
  const name = nonEmptyManifestString(record.name);
  const version = nonEmptyManifestString(record.version);
  return {
    present: true,
    name: name ?? fallbackName,
    version,
    missingName: name === null,
    missingVersion: version === null,
  };
}

/**
 * One warning for a present root `package.json` that omits name, version, or
 * both. Null when the file is absent, unreadable, or both fields are set.
 * The text names the directory, never an absolute path.
 */
export function rootPackageIdentityMessage(identity: RootPackageIdentity): string | null {
  if (!identity.present || (!identity.missingName && !identity.missingVersion)) return null;
  if (identity.missingName && identity.missingVersion) {
    return `Root package.json has no name or version. The root component name is the directory name "${identity.name}", and the version is omitted. Dependencies are still resolved.`;
  }
  if (identity.missingName) {
    return `Root package.json has no name. The root component name is the directory name "${identity.name}". Dependencies are still resolved.`;
  }
  return 'Root package.json has no version. The root component version is omitted. Dependencies are still resolved.';
}
