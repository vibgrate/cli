import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import ts from 'typescript';
import type { VibgrateConfig } from './types.js';
import { pathExists, readTextFile } from './utils/fs.js';

const CONFIG_FILES = [
  'vibgrate.config.ts',
  'vibgrate.config.js',
  'vibgrate.config.json',
];

const TRUSTED_CONFIG_ENV = 'VIBGRATE_TRUST_CONFIG';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toStaticValue(
  expr: ts.Expression,
  constBindings: Map<string, ts.Expression>,
): unknown {
  if (ts.isParenthesizedExpression(expr)) return toStaticValue(expr.expression, constBindings);
  if (ts.isStringLiteralLike(expr)) return expr.text;
  if (ts.isNumericLiteral(expr)) return Number(expr.text);
  if (expr.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (expr.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (expr.kind === ts.SyntaxKind.NullKeyword) return null;

  if (ts.isArrayLiteralExpression(expr)) {
    return expr.elements.map((el) => {
      if (ts.isSpreadElement(el)) throw new Error('Spread not supported in static config arrays');
      return toStaticValue(el as ts.Expression, constBindings);
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

      out[key] = toStaticValue(prop.initializer, constBindings);
    }
    return out;
  }

  if (ts.isIdentifier(expr)) {
    const bound = constBindings.get(expr.text);
    if (!bound) throw new Error(`Unknown identifier in static config: ${expr.text}`);
    return toStaticValue(bound, constBindings);
  }

  throw new Error('Non-static expression in config');
}

function tryParseStaticConfig(text: string, configPath: string): VibgrateConfig | null {
  const scriptKind = configPath.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const source = ts.createSourceFile(configPath, text, ts.ScriptTarget.ESNext, true, scriptKind);
  const constBindings = new Map<string, ts.Expression>();

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
    const parsed = toStaticValue(stmt.expression, constBindings);
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
      if (file.endsWith('.json')) {
        const txt = await readTextFile(configPath);
        config = { ...DEFAULT_CONFIG, ...JSON.parse(txt) };
        break;
      }
      const txt = await readTextFile(configPath);
      let staticConfig: VibgrateConfig | null = null;
      try {
        staticConfig = tryParseStaticConfig(txt, configPath);
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
