/**
 * Locale file codecs.
 *
 * Phase 2 ships the four formats that cover the overwhelming majority of
 * JavaScript/TypeScript projects: `nested` and `flat` JSON, plain `json` (an
 * alias for nested), and `yaml`. The remaining professional formats — PO, XLIFF,
 * Android XML, .strings, RESX, CSV, ARB, properties — land in phase 5 behind the
 * same interface, so adding one is a codec, not a change to push/pull.
 *
 * Every codec round-trips: `decode(encode(x))` must equal `x` for any flat
 * key/value map. That property is what makes `vg locale pull` safe to run over a
 * working tree — a lossy codec would silently rewrite files the user did not
 * intend to change.
 */
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

/** A decoded locale file: flat dotted keys → string values. */
export type FlatCatalog = Record<string, string>;

export interface LocaleCodec {
  id: string;
  /** Conventional file extension, used when a path template omits one. */
  extension: string;
  encode(catalog: FlatCatalog): string;
  decode(text: string): FlatCatalog;
}

/** Formats this build can read and write. */
export const SUPPORTED_FORMATS = ['json', 'nested', 'flat', 'yaml', 'yml'] as const;
export type SupportedFormat = (typeof SUPPORTED_FORMATS)[number];

/**
 * Formats the product will support, including those not yet implemented. Used to
 * tell a user "that's a real format, just not in this build yet" rather than
 * "unknown format", which would read as a typo.
 */
export const PLANNED_FORMATS = [
  'po',
  'xliff',
  'xliff2',
  'android',
  'strings',
  'resx',
  'csv',
  'arb',
  'properties',
] as const;

/**
 * Raised when a catalog cannot be represented as a tree.
 *
 * `a` and `a.b` in the same file need the same slot to be a string and an object
 * at once. Nested JSON and YAML genuinely cannot hold both, and every way of
 * "handling" it silently loses one of the two values — so this is surfaced to
 * the user instead, naming both keys and the format that does work.
 */
export class LocaleNestConflictError extends Error {
  constructor(
    readonly leafKey: string,
    readonly branchKey: string,
  ) {
    super(
      `Cannot write nested output: "${leafKey}" is a value and "${branchKey}" needs it to be a group. ` +
        'Rename one of them, or switch this project to the "flat" format, which stores keys verbatim.',
    );
    this.name = 'LocaleNestConflictError';
  }
}

/**
 * Expand a flat catalog into a nested object.
 *
 * Throws `LocaleNestConflictError` rather than dropping a key — see that class
 * for why silence is not an option here.
 */
export function nest(catalog: FlatCatalog): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(catalog)) {
    const parts = key.split('.');
    let cursor: Record<string, unknown> = out;

    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i]!;
      const existing = cursor[part];
      if (existing === undefined) {
        cursor[part] = {};
      } else if (typeof existing !== 'object' || existing === null || Array.isArray(existing)) {
        // `a` is already a value; `a.b` cannot nest beneath it.
        throw new LocaleNestConflictError(parts.slice(0, i + 1).join('.'), key);
      }
      cursor = cursor[part] as Record<string, unknown>;
    }

    const leaf = parts[parts.length - 1]!;
    const existing = cursor[leaf];
    if (typeof existing === 'object' && existing !== null && !Array.isArray(existing)) {
      // `a.b` already made `a` a group; `a` cannot also be a value.
      throw new LocaleNestConflictError(key, `${key}.…`);
    }
    cursor[leaf] = value;
  }
  return out;
}

/** Collapse a nested object into flat dotted keys. Non-string leaves are stringified. */
export function flatten(input: unknown, prefix = ''): FlatCatalog {
  const out: FlatCatalog = {};
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    if (prefix) out[prefix] = input === null || input === undefined ? '' : String(input);
    return out;
  }
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    const next = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(out, flatten(value, next));
    } else if (Array.isArray(value)) {
      // Arrays are not a key/value shape; preserve them as JSON so the round-trip
      // does not destroy the author's data.
      out[next] = JSON.stringify(value);
    } else {
      out[next] = value === null || value === undefined ? '' : String(value);
    }
  }
  return out;
}

const nestedJson: LocaleCodec = {
  id: 'nested',
  extension: '.json',
  encode: (catalog) => `${JSON.stringify(nest(sortKeys(catalog)), null, 2)}\n`,
  decode: (text) => (text.trim() ? flatten(JSON.parse(text)) : {}),
};

const flatJson: LocaleCodec = {
  id: 'flat',
  extension: '.json',
  encode: (catalog) => `${JSON.stringify(sortKeys(catalog), null, 2)}\n`,
  decode: (text) => {
    if (!text.trim()) return {};
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const out: FlatCatalog = {};
    for (const [key, value] of Object.entries(parsed)) {
      out[key] = value === null || value === undefined ? '' : String(value);
    }
    return out;
  },
};

const yamlCodec: LocaleCodec = {
  id: 'yaml',
  extension: '.yaml',
  encode: (catalog) => stringifyYaml(nest(sortKeys(catalog))),
  decode: (text) => (text.trim() ? flatten(parseYaml(text)) : {}),
};

/**
 * Deterministic key order on write.
 *
 * Without this, pulling the same content twice can produce different bytes and
 * every pull shows up as a diff — which trains people to stop reading them.
 */
export function sortKeys(catalog: FlatCatalog): FlatCatalog {
  return Object.fromEntries(Object.entries(catalog).sort(([a], [b]) => a.localeCompare(b)));
}

const CODECS: Record<string, LocaleCodec> = {
  json: nestedJson,
  nested: nestedJson,
  flat: flatJson,
  yaml: yamlCodec,
  yml: { ...yamlCodec, id: 'yml', extension: '.yml' },
};

export function isSupportedFormat(format: string): boolean {
  return format in CODECS;
}

export function isPlannedFormat(format: string): boolean {
  return (PLANNED_FORMATS as readonly string[]).includes(format);
}

/** Resolve a codec, with an error that distinguishes "not yet" from "not a thing". */
export function codecFor(format: string): LocaleCodec {
  const codec = CODECS[format];
  if (codec) return codec;
  if (isPlannedFormat(format)) {
    throw new Error(
      `The "${format}" format is not available in this release yet. Supported now: ${SUPPORTED_FORMATS.join(', ')}.`,
    );
  }
  throw new Error(
    `Unknown format "${format}". Supported: ${SUPPORTED_FORMATS.join(', ')}. Planned: ${PLANNED_FORMATS.join(', ')}.`,
  );
}
