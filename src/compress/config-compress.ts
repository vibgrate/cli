/**
 * Structured-config compressor (YAML / TOML / INI / JSON-config).
 *
 * Three tiers, lossless first:
 *  1. reversible run/stanza folding (`compactLossless(kind='config')`) — allowed everywhere;
 *  2. whole-line comment / blank elision (recoverable: the original is stored,
 *     the router appends the `Retrieve original:` hint) — marker mode only;
 *  3. schema fold — arrays of tables (`[[toml]]`, YAML sequences of mappings,
 *     JSON-config arrays) re-rendered through the csv-schema compactor —
 *     marker mode only.
 * The smallest candidate wins; a result must be strictly smaller.
 */

import { parse as parseToml } from 'smol-toml';
import { parse as parseYaml } from 'yaml';
import { compactArray, isCompacted, renderCsvSchema, DEFAULT_CRUSHER_CONFIG, type CrusherConfig } from './crusher.js';
import { parseJsonLoose, tryDetectStructuredConfig } from './detect.js';
import { compactLossless } from './lossless.js';
import type { CompressRequest, CompressResponse, Compressor } from './types.js';

export type ConfigFlavor = 'yaml' | 'toml' | 'ini' | 'json' | 'unknown';

const COMMENT_RES: Readonly<Record<string, RegExp>> = { yaml: /^\s*#/, toml: /^\s*#/, ini: /^[#;]/ };
const YAML_BLOCK_SCALAR_RE = /:\s*[|>][+-]?\d*\s*$/m;
const TOML_MULTILINE_RE = /"""|'''/;
const PARSE_CAP = 1_000_000;

export function detectConfigFlavor(text: string): ConfigFlavor {
  const parsed = parseJsonLoose(text);
  if (parsed && parsed.value !== null && typeof parsed.value === 'object' && !Array.isArray(parsed.value)) return 'json';
  const det = tryDetectStructuredConfig(text);
  if (!det) return 'unknown';
  const f = det.metadata.flavor as string;
  return f === 'yaml' || f === 'toml' || f === 'ini' ? f : 'unknown';
}

/** False when a `#` line could be data (YAML block scalars, TOML multi-line strings). */
export function elisionSafe(text: string, flavor: ConfigFlavor): boolean {
  if (flavor === 'yaml') return !YAML_BLOCK_SCALAR_RE.test(text);
  if (flavor === 'toml') return !TOML_MULTILINE_RE.test(text);
  return flavor === 'ini';
}

/** Drop whole-line comments (and, outside INI, blank lines). Trailing newline preserved. */
export function stripCommentLines(text: string, flavor: ConfigFlavor): { text: string; elided: number } {
  const re = COMMENT_RES[flavor] ?? COMMENT_RES.yaml;
  const keepBlanks = flavor === 'ini';
  const trailing = text.endsWith('\n');
  const lines = (trailing ? text.slice(0, -1) : text).split('\n');
  const kept: string[] = [];
  let elided = 0;
  for (const line of lines) {
    if (re.test(line) || (!keepBlanks && !line.trim())) elided++;
    else kept.push(line);
  }
  return { text: kept.join('\n') + (trailing ? '\n' : ''), elided };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function loadConfig(text: string, flavor: ConfigFlavor): Record<string, unknown> | null {
  if (text.length > PARSE_CAP) return null;
  try {
    if (flavor === 'toml') return parseToml(text) as Record<string, unknown>;
    if (flavor === 'yaml') {
      const v = parseYaml(text, { strict: false, logLevel: 'silent' }) as unknown;
      return isRecord(v) ? v : null;
    }
    if (flavor === 'json') {
      const p = parseJsonLoose(text);
      return p && isRecord(p.value) ? p.value : null;
    }
  } catch {
    return null;
  }
  return null;
}

function jsonSafe(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(jsonSafe);
  if (isRecord(v)) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v)) out[k] = jsonSafe(v[k]);
    return out;
  }
  return v;
}

/**
 * Re-render a parsed config: scalar/object keys as `key = <json>` lines, arrays
 * of ≥ `minRows` uniform objects as `[[key]]` + csv-schema blocks. Null when no
 * array qualifies or the compactor declines.
 */
export function schemaFold(doc: Record<string, unknown>, cfg: CrusherConfig, minRows = 3): string | null {
  const out: string[] = [];
  let folded = 0;
  for (const key of Object.keys(doc)) {
    const v = jsonSafe(doc[key]);
    if (Array.isArray(v) && v.length >= minRows && v.every(isRecord)) {
      const c = compactArray(v, cfg, {});
      if (isCompacted(c)) {
        out.push(`[[${key}]]`);
        out.push(renderCsvSchema(c).replace(/\n$/, ''));
        folded++;
        continue;
      }
    }
    out.push(`${key} = ${JSON.stringify(v)}`);
  }
  return folded > 0 ? out.join('\n') : null;
}

export class ConfigCompressor implements Compressor {
  readonly strategy = 'config' as const;
  readonly config: CrusherConfig;

  constructor(config: Partial<CrusherConfig> = {}) {
    this.config = { ...DEFAULT_CRUSHER_CONFIG, ...config };
  }

  compress(req: CompressRequest): CompressResponse {
    const content = req.content;
    const passthrough = (info: string): CompressResponse => ({ content, strategy: 'passthrough', chain: ['config', 'passthrough'], ccrHashes: [], info });
    try {
      const flavor = detectConfigFlavor(content);
      if (flavor === 'unknown') return passthrough('not_config');
      const recoverable = req.injectMarker && !req.losslessOnly;
      // Tier 1
      const tier1 = compactLossless(content, 'config');
      let best = tier1.length < content.length ? { text: tier1, chain: ['lossless_config'], info: `${flavor}:fold`, lossy: false, elided: 0 } : null;
      if (recoverable) {
        // Tier 2
        if (elisionSafe(content, flavor)) {
          const { text: stripped, elided } = stripCommentLines(content, flavor);
          if (elided > 0) {
            const t2 = compactLossless(stripped, 'config');
            const candidate = t2.length < stripped.length ? t2 : stripped;
            if (!best || candidate.length < best.text.length) best = { text: candidate, chain: ['config_elide'], info: `${flavor}:elided ${elided} comment/blank lines`, lossy: true, elided };
          }
        }
        // Tier 3
        const doc = loadConfig(content, flavor);
        if (doc) {
          const t3 = schemaFold(doc, this.config);
          if (t3 && (!best || t3.length < best.text.length)) best = { text: t3, chain: ['config_schema_fold'], info: `${flavor}:schema fold`, lossy: true, elided: 0 };
        }
      }
      if (!best || best.text.length >= content.length) return passthrough(`${flavor}:no_savings`);
      return { content: best.text, strategy: 'config', chain: best.chain, ccrHashes: [], info: best.info };
    } catch {
      return passthrough('error');
    }
  }
}
