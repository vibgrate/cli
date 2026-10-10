// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import type * as TsModule from 'typescript';
import { parseDocument } from 'yaml';
import { parseDriftBudget } from './drift-budget.js';
import type { VibgrateConfig } from './types.js';
import { pathExists, readTextFile } from './utils/fs.js';
import { redactSecrets } from './utils/redact.js';

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
 * A project config file could not be read. The message names the file and,
 * when the parser can say, the line and key — never a source excerpt, so a
 * token sitting on the broken line is not echoed.
 */
export class ConfigFileError extends Error {
  readonly file: string;
  readonly line?: number;
  readonly key?: string;

  constructor(message: string, details: { file: string; line?: number; key?: string }) {
    super(message);
    this.name = 'ConfigFileError';
    this.file = details.file;
    this.line = details.line;
    this.key = details.key;
  }
}

export function isConfigFileError(err: unknown): err is ConfigFileError {
  return err instanceof ConfigFileError || (err instanceof Error && err.name === 'ConfigFileError');
}

/**
 * Parse a data config (YAML or JSON) into a plain object. Throws
 * {@link ConfigFileError} naming the file (and the line or key when the
 * parser can say) when the text is not a valid mapping, or when `driftBudget`
 * or `review` names an unknown key or a value of the wrong type. The message
 * does not include the value.
 */
export function parseDataConfig(text: string, file: string): Record<string, unknown> {
  const parsed = /\.ya?ml$/.test(file) ? parseYamlConfig(text, file) : parseJsonConfig(text, file);
  // An empty YAML file is an empty config, not an error.
  if (parsed === null || parsed === undefined) return {};
  if (!isRecord(parsed)) {
    const found = Array.isArray(parsed) ? 'a list' : `a ${typeof parsed}`;
    throw configFileError(
      `${file} must contain a mapping of settings (found ${found}). Use key: value entries, for example exclude: ["legacy/**"].`,
      { file },
    );
  }
  assertKnownShapes(parsed, text, file);
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
    const message = err instanceof Error ? err.message.split('\n')[0] : 'unreadable';
    return { file, config: null, error: redactSecrets(message || 'unreadable') };
  }
}

/**
 * Like {@link readDataConfigSync}, but a data file that does not parse is an
 * error. A missing file and a `.ts`/`.js` config are unchanged: callers that
 * cannot execute code keep their existing fallback.
 */
export function requireDataConfig(rootDir: string): DataConfigRead {
  const read = readDataConfigSync(rootDir);
  if (read.error && read.file && isDataConfigFile(read.file)) {
    throw new ConfigFileError(read.error, { file: read.file });
  }
  return read;
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

function configFileError(
  message: string,
  details: { file: string; line?: number; key?: string },
): ConfigFileError {
  return new ConfigFileError(redactSecrets(message), details);
}

interface SourceLocation {
  line?: number;
  column?: number;
}

function locationOf(err: unknown): SourceLocation {
  const tagged = err as { linePos?: Array<{ line?: number; col?: number }>; message?: string };
  const pos = tagged?.linePos?.[0];
  if (pos && typeof pos.line === 'number' && pos.line > 0) {
    return { line: pos.line, column: typeof pos.col === 'number' && pos.col > 0 ? pos.col : undefined };
  }
  const first = typeof tagged?.message === 'string' ? (tagged.message.split('\n')[0] ?? '') : '';
  const match = /at line (\d+), column (\d+)/.exec(first);
  if (!match) return {};
  return { line: Number(match[1]), column: Number(match[2]) };
}

/** Parser reason with the source preview and the repeated location stripped. */
function parserReason(err: unknown): string {
  const raw = err instanceof Error ? err.message : '';
  let line = raw.split('\n')[0] ?? '';
  line = line.replace(/\s+at line \d+, column \d+:?\s*$/i, '').trim();
  line = redactSecrets(line).trim();
  if (!line) return 'the syntax could not be read';
  return line.length > 180 ? `${line.slice(0, 177)}...` : line;
}

function whereAt(loc: SourceLocation): string {
  if (loc.line === undefined) return '';
  return ` at line ${loc.line}${loc.column !== undefined ? `, column ${loc.column}` : ''}`;
}

function yamlFailure(file: string, err: unknown): ConfigFileError {
  const loc = locationOf(err);
  return configFileError(
    `${file} is not valid YAML${whereAt(loc)}: ${parserReason(err)}. Fix the file and run the command again.`,
    { file, line: loc.line },
  );
}

function parseYamlConfig(text: string, file: string): unknown {
  let doc: ReturnType<typeof parseDocument>;
  try {
    doc = parseDocument(text);
  } catch (err) {
    throw yamlFailure(file, err);
  }
  if (doc.errors.length > 0) throw yamlFailure(file, doc.errors[0]);
  try {
    return doc.toJS();
  } catch (err) {
    throw yamlFailure(file, err);
  }
}

function jsonLocation(text: string, err: unknown): SourceLocation {
  const message = err instanceof Error ? err.message : '';
  // Use only the coordinates Node puts in the message. The rest of the
  // message quotes a slice of the file, which is where a token would leak.
  const explicit = /\(line (\d+) column (\d+)\)/.exec(message);
  if (explicit) return { line: Number(explicit[1]), column: Number(explicit[2]) };
  const pos = /position (\d+)/.exec(message);
  if (pos) {
    const index = Number(pos[1]);
    if (Number.isFinite(index) && index >= 0) {
      const slice = text.slice(0, index);
      const parts = slice.split('\n');
      return { line: parts.length, column: (parts[parts.length - 1]?.length ?? 0) + 1 };
    }
  }
  if (/Unexpected end of JSON input/.test(message) && text.length > 0) {
    const parts = text.split('\n');
    const last = parts[parts.length - 1] ?? '';
    return { line: parts.length, column: last.length + 1 };
  }
  return {};
}

function parseJsonConfig(text: string, file: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    const loc = jsonLocation(text, err);
    // The JSON parser quotes a slice of the file. Do not repeat it — that
    // slice is where a token would leak.
    throw configFileError(
      `${file} is not valid JSON${whereAt(loc)}. Fix the file and run the command again.`,
      { file, line: loc.line },
    );
  }
}

interface ShapeCheck {
  key: string;
  ok: (value: unknown) => boolean;
  expect: string;
}

function isStringList(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isNonNegativeNumber(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

const SHAPE_CHECKS: readonly ShapeCheck[] = [
  { key: 'include', ok: isStringList, expect: 'a list of strings, for example include: ["src/**"]' },
  { key: 'exclude', ok: isStringList, expect: 'a list of strings, for example exclude: ["legacy/**"]' },
  { key: 'maxFileSizeToScan', ok: isNonNegativeNumber, expect: 'a number of bytes, for example maxFileSizeToScan: 5242880' },
  { key: 'projectScanTimeout', ok: isNonNegativeNumber, expect: 'a number of seconds, for example projectScanTimeout: 180' },
  { key: 'areaSkills', ok: (value) => typeof value === 'boolean', expect: 'true or false' },
  { key: 'scanners', ok: (value) => value === false || isRecord(value), expect: 'a mapping of scanner settings, or false' },
  { key: 'thresholds', ok: isRecord, expect: 'a mapping of threshold settings' },
  { key: 'driftBudget', ok: isRecord, expect: 'a mapping of budget settings' },
  { key: 'review', ok: isRecord, expect: 'a mapping of review settings' },
];

function lineOfKey(text: string, file: string, key: string): number | undefined {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = /\.json$/.test(file)
    ? new RegExp(`"${escaped}"\\s*:`)
    : new RegExp(`^(?:"${escaped}"|'${escaped}'|${escaped})\\s*:`);
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i] ?? '')) return i + 1;
  }
  return undefined;
}

function assertKnownShapes(parsed: Record<string, unknown>, text: string, file: string): void {
  for (const check of SHAPE_CHECKS) {
    if (!Object.prototype.hasOwnProperty.call(parsed, check.key)) continue;
    if (check.ok(parsed[check.key])) continue;
    const line = lineOfKey(text, file, check.key);
    const at = line !== undefined ? ` (line ${line})` : '';
    throw configFileError(
      `${file}: \`${check.key}\` must be ${check.expect}${at}. Fix that key and run the command again.`,
      { file, line, key: check.key },
    );
  }
  // A mapping still has to name known keys and the right types, so a typo
  // stops the command instead of scanning or reviewing under defaults.
  if (isRecord(parsed.driftBudget)) assertDriftBudgetShape(parsed.driftBudget, text, file);
  if (isRecord(parsed.review)) assertReviewBlock(parsed.review, text, file);
}

function throwKeyProblem(file: string, text: string, key: string, problem: string): never {
  const line = lineOfPath(text, file, key.split('.'));
  const at = line !== undefined ? ` (line ${line})` : '';
  throw configFileError(
    `${file}: \`${key}\` ${problem}${at}. Fix that key and run the command again.`,
    { file, line, key },
  );
}

/** First `parseDriftBudget` failure, as a config error. Same input, same message. */
function assertDriftBudgetShape(value: unknown, text: string, file: string): void {
  const parsed = parseDriftBudget(value);
  if (!parsed || parsed.ok) return;
  const error = parsed.errors[0] ?? 'driftBudget is not valid.';
  const match = /^(driftBudget(?:\.[^ ]+)*)\s+([\s\S]+)$/.exec(error);
  const key = match?.[1] ?? 'driftBudget';
  const problem = (match?.[2] ?? error).replace(/\.$/, '');
  throwKeyProblem(file, text, key, problem);
}

const REVIEW_KEYS = [
  'enforcement',
  'failOn',
  'targetPattern',
  'approvedExceptions',
  'protected',
  'highConfidenceThreshold',
  'highSeverityDecision',
  'detectionMode',
  'minSeverity',
] as const;

const REVIEW_KEY_SET: ReadonlySet<string> = new Set(REVIEW_KEYS);

const REVIEW_ENUMS: Record<string, readonly string[]> = {
  enforcement: ['advisory', 'enforced'],
  failOn: ['none', 'fail', 'needs_review'],
  highSeverityDecision: ['fail', 'needs_review'],
  detectionMode: ['budget', 'balanced', 'precise', 'ultra'],
  minSeverity: ['low', 'medium', 'high', 'critical'],
};

const PROTECTED_KEYS = ['unguardedEntrypoint', 'knownVulnerableDependency', 'validatedTaint'] as const;
const PROTECTED_KEY_SET: ReadonlySet<string> = new Set(PROTECTED_KEYS);

function joinWords(values: readonly string[]): string {
  if (values.length <= 1) return values[0] ?? '';
  if (values.length === 2) return `${values[0]} or ${values[1]}`;
  return `${values.slice(0, -1).join(', ')}, or ${values[values.length - 1]}`;
}

function joinQuoted(values: readonly string[]): string {
  return joinWords(values.map((value) => `"${value}"`));
}

/**
 * Known `review` keys with the wrong type, and unknown keys, are errors.
 * A misspelt policy key must not silently keep the default (often a weaker
 * gate). Absent keys are fine — those keep their defaults later.
 */
function assertReviewBlock(block: Record<string, unknown>, text: string, file: string): void {
  for (const key of Object.keys(block)) {
    const path = `review.${key}`;
    if (!REVIEW_KEY_SET.has(key)) {
      throwKeyProblem(file, text, path, `is not a known setting. Use ${joinWords(REVIEW_KEYS)}`);
    }
    const problem = reviewFieldProblem(key, block[key]);
    if (problem) throwKeyProblem(file, text, problem.key, problem.problem);
  }
}

function reviewFieldProblem(key: string, value: unknown): { key: string; problem: string } | null {
  const path = `review.${key}`;
  const allowed = REVIEW_ENUMS[key];
  if (allowed) {
    if (typeof value === 'string' && allowed.includes(value)) return null;
    return { key: path, problem: `must be ${joinQuoted(allowed)}` };
  }
  if (key === 'targetPattern') {
    return typeof value === 'string' ? null : { key: path, problem: 'must be a string' };
  }
  if (key === 'approvedExceptions') {
    return isStringList(value)
      ? null
      : { key: path, problem: 'must be a list of strings, for example approvedExceptions: ["ui/api"]' };
  }
  if (key === 'highConfidenceThreshold') {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1) return null;
    return { key: path, problem: 'must be a number from 0 to 1' };
  }
  if (key === 'protected') return protectedProblem(value);
  return { key: path, problem: 'is not a supported setting' };
}

function protectedProblem(value: unknown): { key: string; problem: string } | null {
  if (!isRecord(value)) {
    return { key: 'review.protected', problem: 'must be a mapping of true or false settings' };
  }
  for (const key of Object.keys(value)) {
    const path = `review.protected.${key}`;
    if (!PROTECTED_KEY_SET.has(key)) {
      return { key: path, problem: `is not a known setting. Use ${joinWords(PROTECTED_KEYS)}` };
    }
    if (typeof value[key] !== 'boolean') return { key: path, problem: 'must be true or false' };
  }
  return null;
}

function lineOfPath(text: string, file: string, parts: readonly string[]): number | undefined {
  if (parts.length === 0) return undefined;
  return /\.json$/.test(file) ? lineOfJsonPath(text, parts) : lineOfYamlPath(text, parts);
}

function lineOfJsonPath(text: string, parts: readonly string[]): number | undefined {
  let from = 0;
  let found: number | undefined;
  for (const part of parts) {
    const match = jsonKeyRe(part).exec(text.slice(from));
    if (!match) return found;
    const index = from + match.index;
    found = text.slice(0, index).split(/\r?\n/).length;
    from = index + match[0].length;
  }
  return found;
}

function jsonKeyRe(key: string): RegExp {
  return new RegExp(`"${escapeRegExp(key)}"\\s*:`);
}

function lineOfYamlPath(text: string, parts: readonly string[]): number | undefined {
  const lines = text.split(/\r?\n/);
  let lineIndex = 0;
  let minIndent = 0;
  let found: number | undefined;
  for (let depth = 0; depth < parts.length; depth++) {
    const re = yamlKeyRe(parts[depth] ?? '');
    let hit: number | undefined;
    let indent = 0;
    for (let i = lineIndex; i < lines.length; i++) {
      const line = lines[i] ?? '';
      const trimmed = line.trim();
      if (trimmed === '' || trimmed.startsWith('#')) continue;
      const indentNow = leadingSpaces(line);
      if (depth > 0 && indentNow < minIndent) return found;
      if (!re.test(line)) continue;
      indent = indentNow;
      hit = i;
      break;
    }
    if (hit === undefined) return found;
    found = hit + 1;
    lineIndex = hit + 1;
    minIndent = indent + 1;
  }
  return found;
}

function yamlKeyRe(key: string): RegExp {
  const escaped = escapeRegExp(key);
  return new RegExp(`^\\s*(?:${escaped}|"${escaped}"|'${escaped}')\\s*:`);
}

function leadingSpaces(line: string): number {
  return /^ */.exec(line)?.[0].length ?? 0;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
