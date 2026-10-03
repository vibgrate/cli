// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import type * as TsModule from 'typescript';
import { parse as parseYaml } from 'yaml';
import type { VibgrateConfig } from './types.js';
import { pathExists, readTextFile } from './utils/fs.js';

/**
 * The project config, in lookup order. The FIRST file found is the config;
 * files are never merged. `.vibgrate/config.yml` takes the same keys as
 * `vibgrate.config.json` and wins over it when both exist.
 *
 * Keep in sync with the GitHub App's copy in
 * `packages/vibgrate-api/src/lib/github-app/repo-config.ts`.
 */
export const CONFIG_FILES = [
  '.vibgrate/config.yml',
  '.vibgrate/config.yaml',
  'vibgrate.config.ts',
  'vibgrate.config.js',
  'vibgrate.config.json',
] as const;

export type ConfigFile = (typeof CONFIG_FILES)[number];

/** YAML and JSON are data; `.ts` / `.js` configs are code and need the loader. */
export function isDataConfigFile(file: string): boolean {
  return /\.(ya?ml|json)$/.test(file);
}

/**
 * A project config that cannot be used. The message names the file and, when
 * the parser can tell, the line and the key. It never includes the source line,
 * so a token-like value on that line is not echoed.
 */
export class ProjectConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectConfigError';
  }
}

function configKind(file: string): 'YAML' | 'JSON' {
  return /\.ya?ml$/.test(file) ? 'YAML' : 'JSON';
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/** A mapping key at the start of a line. The rest of the line is ignored. */
function keyOnLine(line: string): string | undefined {
  const match = /^\s*(?:-\s+)?[{,]?\s*(?:(['"])([A-Za-z_][\w.-]*)\1|([A-Za-z_][\w.-]*))\s*:/.exec(line);
  const key = match?.[2] ?? match?.[3];
  return key && key.length > 0 ? key : undefined;
}

/**
 * The key to fix for a parser line. The broken line is preferred; an unclosed
 * value often lands on the following blank line, so the nearest key above it
 * is used. Only the key is returned — never the line text.
 */
function keyForLine(text: string, line: number): string | undefined {
  const lines = text.split(/\r?\n/);
  const start = line - 1;
  const from = start >= 0 && start < lines.length ? start : lines.length - 1;
  for (let i = from; i >= 0; i--) {
    const key = keyOnLine(lines[i] ?? '');
    if (key) return key;
  }
  return undefined;
}

function lineOfKey(text: string, key: string): number | undefined {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (keyOnLine(lines[i] ?? '') === key) return i + 1;
  }
  return undefined;
}

/** Line number from the parser, without copying any of its message text. */
function parserLine(text: string, err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const pretty = (err as { linePos?: Array<{ line?: number }> }).linePos?.[0]?.line;
  if (typeof pretty === 'number' && Number.isInteger(pretty) && pretty > 0) return pretty;
  const pos = (err as { pos?: Array<number | null | undefined> }).pos?.[0];
  if (typeof pos === 'number' && Number.isInteger(pos) && pos >= 0) {
    return text.slice(0, Math.min(pos, text.length)).split('\n').length;
  }
  if (err instanceof Error) {
    const named = /\(line (\d+)\b/.exec(err.message);
    if (named) {
      const line = Number(named[1]);
      if (Number.isInteger(line) && line > 0) return line;
    }
    const position = /\bposition (\d+)\b/.exec(err.message);
    if (position) {
      const index = Number(position[1]);
      if (Number.isInteger(index) && index >= 0) {
        return text.slice(0, Math.min(index, text.length)).split('\n').length;
      }
    }
  }
  return undefined;
}

function formatParseError(file: string, text: string, err: unknown): string {
  const line = parserLine(text, err);
  const key = line ? keyForLine(text, line) : undefined;
  let message = `${file} is not valid ${configKind(file)}`;
  if (line) message += ` at line ${line}`;
  if (key) message += `, key ${key}`;
  return message;
}

function formatExcludeError(file: string, text: string): string {
  const line = lineOfKey(text, 'exclude');
  let message = `${file}: exclude must be a list of strings`;
  if (line) message += ` at line ${line}`;
  return message;
}

/**
 * Parse a data config (YAML or JSON) into a plain object. Throws
 * {@link ProjectConfigError} naming the file when the text is not a valid
 * mapping, or when `exclude` is present and is not a list of strings.
 * An empty file is an empty config, not an error.
 */
export function parseDataConfig(text: string, file: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = /\.ya?ml$/.test(file) ? parseYaml(text) : JSON.parse(text);
  } catch (err) {
    throw new ProjectConfigError(formatParseError(file, text, err));
  }
  // An empty YAML file is an empty config, not an error.
  if (parsed === null || parsed === undefined) return {};
  if (!isRecord(parsed)) throw new ProjectConfigError(`${file} must contain a mapping of settings.`);
  if ('exclude' in parsed && !isStringList(parsed.exclude)) {
    throw new ProjectConfigError(formatExcludeError(file, text));
  }
  return parsed;
}

/** The config file this project uses, relative to `rootDir`, or null. */
export function findConfigFile(rootDir: string): ConfigFile | null {
  return CONFIG_FILES.find((file) => existsSync(path.join(rootDir, file))) ?? null;
}

/** Config files present but not read, because an earlier one in the lookup order won. */
export function shadowedConfigFiles(rootDir: string): ConfigFile[] {
  const present = CONFIG_FILES.filter((file) => existsSync(path.join(rootDir, file)));
  return present.slice(1);
}

export interface DataConfigRead {
  /** The config file in effect, or null when the project has none. */
  file: ConfigFile | null;
  /** Parsed settings. Null for no config, a `.ts`/`.js` config, or an invalid file. */
  config: Record<string, unknown> | null;
  /** Why `config` is null despite a file existing. */
  error?: string;
}

/**
 * Synchronously read the project config when it is data (YAML or JSON), for
 * callers that need one setting without running a scan. A `.ts`/`.js` config
 * is reported, not executed — `loadConfig` is the only path that reads those.
 */
export function readDataConfigSync(rootDir: string): DataConfigRead {
  const file = findConfigFile(rootDir);
  if (!file) return { file: null, config: null };
  if (!isDataConfigFile(file)) {
    return { file, config: null, error: `${file} is code; this setting is read from .vibgrate/config.yml or vibgrate.config.json.` };
  }
  try {
    return { file, config: parseDataConfig(readFileSync(path.join(rootDir, file), 'utf8'), file) };
  } catch (err) {
    return { file, config: null, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The config problem to show or fail on. A `.ts` / `.js` config is code and is
 * reported separately (`is code`); it is not a parse failure.
 */
export function projectConfigError(read: DataConfigRead): string | undefined {
  if (!read.error || read.error.includes('is code')) return undefined;
  return read.error;
}

/** Throw when the project data config cannot be read. No-op when there is none. */
export function assertProjectConfig(rootDir: string): void {
  const problem = projectConfigError(readDataConfigSync(rootDir));
  if (problem) throw new ProjectConfigError(problem);
}

const TRUSTED_CONFIG_ENV = 'VIBGRATE_TRUST_CONFIG';

// The TypeScript compiler is loaded LAZILY, only when we actually need to parse
// a user's vibgrate.config.ts. Importing it at module-init would drag the whole
// ~10 MB compiler into every consumer bundle — including the Cloudflare Worker
// (@vibgrate/core → @vibgrate/core-open), where TypeScript's Node system probe
// touches `__filename` and crashes the deploy ("ReferenceError: __filename is
// not defined"). Deferring the import keeps that code path off the Worker's
// startup entirely; it runs only on a real filesystem when a .ts config exists.
let tsPromise: Promise<typeof TsModule> | null = null;
function loadTypeScript(): Promise<typeof TsModule> {
  tsPromise ??= import('typescript').then((m) => {
    const mod = m as unknown as { default?: typeof TsModule };
    return mod.default ?? (m as unknown as typeof TsModule);
  });
  return tsPromise;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toStaticValue(
  expr: TsModule.Expression,
  constBindings: Map<string, TsModule.Expression>,
  ts: typeof TsModule,
): unknown {
  if (ts.isParenthesizedExpression(expr)) return toStaticValue(expr.expression, constBindings, ts);
  if (ts.isStringLiteralLike(expr)) return expr.text;
  if (ts.isNumericLiteral(expr)) return Number(expr.text);
  if (expr.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (expr.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (expr.kind === ts.SyntaxKind.NullKeyword) return null;

  if (ts.isArrayLiteralExpression(expr)) {
    return expr.elements.map((el) => {
      if (ts.isSpreadElement(el)) throw new Error('Spread not supported in static config arrays');
      return toStaticValue(el as TsModule.Expression, constBindings, ts);
    });
  }

  if (ts.isObjectLiteralExpression(expr)) {
    const out: Record<string, unknown> = {};
    for (const prop of expr.properties) {
      if (!ts.isPropertyAssignment(prop) || prop.initializer === undefined) {
        throw new Error('Only plain object properties are supported in static config');
      }
      if (ts.isComputedPropertyName(prop.name)) {
        throw new Error('Computed property names are not supported in static config');
      }

      const key = ts.isIdentifier(prop.name)
        ? prop.name.text
        : ts.isStringLiteral(prop.name)
          ? prop.name.text
          : ts.isNumericLiteral(prop.name)
            ? prop.name.text
            : null;

      if (key === null) {
        throw new Error('Unsupported object key in static config');
      }

      out[key] = toStaticValue(prop.initializer, constBindings, ts);
    }
    return out;
  }

  if (ts.isIdentifier(expr)) {
    const bound = constBindings.get(expr.text);
    if (!bound) throw new Error(`Unknown identifier in static config: ${expr.text}`);
    return toStaticValue(bound, constBindings, ts);
  }

  throw new Error('Non-static expression in config');
}

async function tryParseStaticConfig(text: string, configPath: string): Promise<VibgrateConfig | null> {
  const ts = await loadTypeScript();
  const scriptKind = configPath.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const source = ts.createSourceFile(configPath, text, ts.ScriptTarget.ESNext, true, scriptKind);
  const constBindings = new Map<string, TsModule.Expression>();

  for (const stmt of source.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    if (!(stmt.declarationList.flags & ts.NodeFlags.Const)) continue;

    for (const decl of stmt.declarationList.declarations) {
      if (ts.isIdentifier(decl.name) && decl.initializer) {
        constBindings.set(decl.name.text, decl.initializer);
      }
    }
  }

  for (const stmt of source.statements) {
    if (!ts.isExportAssignment(stmt)) continue;
    const parsed = toStaticValue(stmt.expression, constBindings, ts);
    if (!isRecord(parsed)) return null;
    return { ...DEFAULT_CONFIG, ...parsed } as VibgrateConfig;
  }

  return null;
}

/** 5 MB — default ceiling for individual files read during a scan */
const DEFAULT_MAX_FILE_SIZE = 5_242_880;

/** 3 minutes — default per-project scan timeout (seconds) */
const DEFAULT_PROJECT_SCAN_TIMEOUT = 180;

const DEFAULT_CONFIG: VibgrateConfig = {
  exclude: [],
  maxFileSizeToScan: DEFAULT_MAX_FILE_SIZE,
  projectScanTimeout: DEFAULT_PROJECT_SCAN_TIMEOUT,
  thresholds: {
    failOnError: {
      eolDays: 180,
      frameworkMajorLag: 3,
      dependencyTwoPlusPercent: 50,
    },
    warn: {
      frameworkMajorLag: 2,
      dependencyTwoPlusPercent: 30,
    },
  },
};

export async function loadConfig(rootDir: string): Promise<VibgrateConfig> {
  let config = DEFAULT_CONFIG;

  for (const file of CONFIG_FILES) {
    const configPath = path.join(rootDir, file);
    if (await pathExists(configPath)) {
      if (isDataConfigFile(file)) {
        const txt = await readTextFile(configPath);
        config = { ...DEFAULT_CONFIG, ...parseDataConfig(txt, file) } as VibgrateConfig;
        break;
      }
      const txt = await readTextFile(configPath);
      let staticConfig: VibgrateConfig | null = null;
      try {
        staticConfig = await tryParseStaticConfig(txt, configPath);
      } catch {
        staticConfig = null;
      }
      if (staticConfig) {
        config = staticConfig;
        break;
      }
      // Dynamic imports execute arbitrary code from the scanned repository.
      // Require explicit opt-in for this behavior.
      if (process.env[TRUSTED_CONFIG_ENV] === '1') {
        try {
          const mod = await import(configPath);
          config = { ...DEFAULT_CONFIG, ...(mod.default ?? mod) };
          break;
        } catch {
          // Fall back to default
        }
      }
    }
  }

  // Merge sidecar auto-excludes (from stuck-dir detection)
  const sidecarPath = path.join(rootDir, '.vibgrate', 'auto-excludes.json');
  if (await pathExists(sidecarPath)) {
    try {
      const txt = await readTextFile(sidecarPath);
      const autoExcludes = JSON.parse(txt);
      if (Array.isArray(autoExcludes) && autoExcludes.length > 0) {
        const existing = config.exclude ?? [];
        config = { ...config, exclude: [...new Set([...existing, ...autoExcludes])] };
      }
    } catch {
      // ignore corrupt sidecar
    }
  }

  return config;
}

export async function writeDefaultConfig(rootDir: string): Promise<string> {
  const configPath = path.join(rootDir, 'vibgrate.config.ts');

  const content = `import type { VibgrateConfig } from '@vibgrate/cli';

const config: VibgrateConfig = {
  // exclude: ['legacy/**'],
  // maxFileSizeToScan: 5_242_880, // 5 MB (default)
  // projectScanTimeout: 180, // 3 min per project (default, in seconds)
  thresholds: {
    failOnError: {
      eolDays: 180,
      frameworkMajorLag: 3,
      dependencyTwoPlusPercent: 50,
    },
    warn: {
      frameworkMajorLag: 2,
      dependencyTwoPlusPercent: 30,
    },
  },
};

export default config;
`;

  await fs.writeFile(configPath, content, 'utf8');
  return configPath;
}

/**
 * Append exclude patterns to the config file.
 * Deduplicates against existing excludes and writes back.
 * Supports .json configs directly; for .ts/.js configs, falls back to creating
 * a .vibgrate/auto-excludes.json sidecar (merged on next loadConfig).
 * Returns true if patterns were persisted.
 */
export async function appendExcludePatterns(rootDir: string, newPatterns: string[]): Promise<boolean> {
  if (newPatterns.length === 0) return false;

  // Try JSON config first (easiest to update programmatically)
  const jsonPath = path.join(rootDir, 'vibgrate.config.json');
  if (await pathExists(jsonPath)) {
    try {
      const txt = await readTextFile(jsonPath);
      const cfg = JSON.parse(txt) as Record<string, unknown>;
      const existing = Array.isArray(cfg.exclude) ? (cfg.exclude as string[]) : [];
      const merged = [...new Set([...existing, ...newPatterns])];
      cfg.exclude = merged;
      await fs.writeFile(jsonPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
      return true;
    } catch {
      // fall through
    }
  }

  // For .ts/.js configs (or no config at all), use a sidecar JSON
  const vibgrateDir = path.join(rootDir, '.vibgrate');
  const sidecarPath = path.join(vibgrateDir, 'auto-excludes.json');
  let existing: string[] = [];
  if (await pathExists(sidecarPath)) {
    try {
      const txt = await readTextFile(sidecarPath);
      const parsed = JSON.parse(txt);
      if (Array.isArray(parsed)) existing = parsed;
    } catch {
      // ignore
    }
  }
  const merged = [...new Set([...existing, ...newPatterns])];
  try {
    await fs.mkdir(vibgrateDir, { recursive: true });
    await fs.writeFile(sidecarPath, JSON.stringify(merged, null, 2) + '\n', 'utf8');
    return true;
  } catch {
    return false;
  }
}
