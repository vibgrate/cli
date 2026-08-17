/**
 * `vibgrate.locale.yaml` — declarative locale project configuration.
 *
 * The config file NEVER holds a credential. The DSN resolves at call time from
 * `--dsn` → `VIBGRATE_DSN` → the stored login, exactly as `vg push` does. This
 * file is expected to be committed, so a secret in it would be a secret in the
 * customer's git history.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

export const LOCALE_CONFIG_FILENAMES = ['vibgrate.locale.yaml', '.vibgrate/locale.yaml'] as const;

export interface LocaleConfig {
  /** Locale project slug or id in Vibgrate Cloud. */
  project?: string;
  sourceLanguage?: string;
  targetLanguages?: string[];
  format?: string;
  /** Path template, e.g. `src/locales/{language}/{namespace}.json`. */
  path?: string;
  namespaces?: string[];
  version?: string;
}

export interface LoadedLocaleConfig {
  config: LocaleConfig;
  /** Absolute path the config was read from, or null when none exists. */
  file: string | null;
}

/** Find the nearest config file, searching the documented names in order. */
export function findLocaleConfig(cwd: string): string | null {
  for (const name of LOCALE_CONFIG_FILENAMES) {
    const candidate = path.join(cwd, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Parse a config file's text.
 *
 * Exported separately from the filesystem read so the parsing rules can be
 * tested without touching disk. Unknown keys are preserved-but-ignored rather
 * than rejected: a config written by a newer CLI must not break an older one.
 */
export function parseLocaleConfig(text: string): LocaleConfig {
  const raw = parseYaml(text) as unknown;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const obj = raw as Record<string, unknown>;

  const stringArray = (value: unknown): string[] | undefined => {
    if (!Array.isArray(value)) return undefined;
    const items = value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
    return items.length ? items : undefined;
  };
  const str = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() ? value.trim() : undefined;

  return {
    project: str(obj.project),
    sourceLanguage: str(obj.sourceLanguage),
    targetLanguages: stringArray(obj.targetLanguages),
    format: str(obj.format),
    path: str(obj.path),
    namespaces: stringArray(obj.namespaces),
    version: str(obj.version),
  };
}

export function loadLocaleConfig(cwd: string): LoadedLocaleConfig {
  const file = findLocaleConfig(cwd);
  if (!file) return { config: {}, file: null };
  try {
    return { config: parseLocaleConfig(fs.readFileSync(file, 'utf8')), file };
  } catch (error) {
    throw new Error(
      `Could not parse ${path.relative(cwd, file)}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Serialise a config, dropping empty fields so the file stays readable. */
export function serializeLocaleConfig(config: LocaleConfig): string {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (typeof value === 'string' && !value.trim()) continue;
    out[key] = value;
  }
  return stringifyYaml(out);
}

export function writeLocaleConfig(cwd: string, config: LocaleConfig, filename?: string): string {
  const target = filename ?? path.join(cwd, LOCALE_CONFIG_FILENAMES[0]);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, serializeLocaleConfig(config), 'utf8');
  return target;
}

/**
 * Merge CLI flags over config-file values.
 *
 * Flags win, then the config file. Nothing here reads a credential — see the
 * module header.
 */
export function resolveLocaleSettings(
  config: LocaleConfig,
  flags: Partial<LocaleConfig>,
): LocaleConfig {
  return {
    project: flags.project ?? config.project,
    sourceLanguage: flags.sourceLanguage ?? config.sourceLanguage ?? 'en-US',
    targetLanguages: flags.targetLanguages ?? config.targetLanguages ?? [],
    format: flags.format ?? config.format ?? 'nested',
    path: flags.path ?? config.path ?? 'src/locales/{language}/{namespace}.json',
    namespaces: flags.namespaces ?? config.namespaces ?? ['common'],
    version: flags.version ?? config.version ?? 'latest',
  };
}
