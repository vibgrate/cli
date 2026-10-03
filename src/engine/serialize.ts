import { SUPPORTED_SCHEMA_VERSIONS, type SupportedSchemaVersion, type VgGraph } from '../schema.js';
import { CliError, ExitCode } from '../util/exit.js';

/**
 * Deterministic serialization of `graph.json`.
 *
 * Object keys are sorted recursively and arrays are emitted in the (already
 * stable) order the engine produced them, so two runs over identical content
 * yield byte-identical output — the determinism contract (VG-CLI-SPEC §1.3).
 * Pretty-printed (2-space) and newline-terminated so the committed artifact is
 * human-diffable and plays well with the union merge driver.
 */
export function serializeGraph(graph: VgGraph, opts?: { compact?: boolean }): string {
  // Compact (no pretty-print) for large maps / CI artifacts — still deterministic.
  const indent = opts?.compact ? 0 : 2;
  return `${stableStringify(graph, indent)}\n`;
}

/**
 * Drop heavy optional fields for export/sharing when size matters.
 * Does not mutate the input graph.
 */
export function slimGraphForExport(graph: VgGraph): VgGraph {
  return {
    ...graph,
    areas: graph.areas.map((a) => ({
      ...a,
      members: [], // member id lists dominate XL exports; area id still on nodes
    })),
    grounding: undefined,
    facts: graph.facts,
    // Keep summaries/unknowns — small and useful to agents.
  };
}

export function stableStringify(value: unknown, indent = 2): string {
  return JSON.stringify(sortKeys(value), null, indent);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const input = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(input).sort()) {
      const v = input[key];
      if (v === undefined) continue; // omit undefined for stable output
      out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

/** Why a code map on disk could not be loaded. */
export type GraphLoadFailure = 'truncated' | 'invalid-json' | 'unsupported-schema';

const REBUILD_HINT = 'rebuild it with `vg build`';

/**
 * Schema tokens safe to repeat in an error. Anything else (spaces, newlines,
 * a long blob) is treated as file contents and is not echoed.
 */
const SCHEMA_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._+/-]{0,63}$/;

/**
 * A code map exists but this process cannot use it. The message names the
 * failure and tells the operator to rebuild; it never includes file contents.
 * Exit code is {@link ExitCode.ERROR}, distinct from a missing map.
 */
export class GraphLoadError extends CliError {
  readonly failure: GraphLoadFailure;

  constructor(failure: GraphLoadFailure, schemaVersion?: string) {
    super(graphLoadMessage(failure, schemaVersion), ExitCode.ERROR);
    this.name = 'GraphLoadError';
    this.failure = failure;
  }
}

export function graphLoadMessage(failure: GraphLoadFailure, schemaVersion?: string): string {
  switch (failure) {
    case 'truncated':
      return `code map is truncated — ${REBUILD_HINT}`;
    case 'invalid-json':
      return `code map is not valid JSON — ${REBUILD_HINT}`;
    case 'unsupported-schema':
      return schemaVersion
        ? `code map uses schema ${schemaVersion}, which this version cannot read — ${REBUILD_HINT}`
        : `code map uses a schema this version cannot read — ${REBUILD_HINT}`;
  }
}

export function isSupportedSchemaVersion(value: unknown): value is SupportedSchemaVersion {
  return typeof value === 'string' && (SUPPORTED_SCHEMA_VERSIONS as readonly string[]).includes(value);
}

/**
 * Accept a parsed value only when its `schemaVersion` is one this build can
 * read (`vg-graph/1.0` and `vg-graph/1.1`). Structural fields are not
 * re-checked here — a supported document loads as written.
 */
export function assertSupportedGraph(value: unknown): VgGraph {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new GraphLoadError('unsupported-schema');
  }
  const schemaVersion = (value as { schemaVersion?: unknown }).schemaVersion;
  if (!isSupportedSchemaVersion(schemaVersion)) {
    const label = typeof schemaVersion === 'string' && SCHEMA_TOKEN.test(schemaVersion) ? schemaVersion : undefined;
    throw new GraphLoadError('unsupported-schema', label);
  }
  return value as VgGraph;
}

export function parseGraph(json: string): VgGraph {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (err) {
    throw new GraphLoadError(jsonFailure(json, err));
  }
  return assertSupportedGraph(value);
}

/**
 * Truncation is "the document ended before it was complete": unexpected EOF,
 * an unterminated string, or a syntax error parked at the end of the input.
 * A bad token in the middle is invalid JSON. The parser's own message is
 * never returned — it can quote the file.
 */
function jsonFailure(text: string, err: unknown): 'truncated' | 'invalid-json' {
  const message = err instanceof Error ? err.message : '';
  if (message.includes('Unexpected end of JSON input') || message.includes('Unterminated string')) {
    return 'truncated';
  }
  const at = /position (\d+)/.exec(message);
  if (at && Number(at[1]) >= text.trimEnd().length) return 'truncated';
  return 'invalid-json';
}
