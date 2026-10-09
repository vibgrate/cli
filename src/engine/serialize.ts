import { SUPPORTED_SCHEMA_VERSIONS, type SupportedSchemaVersion, type VgGraph } from '../schema.js';
import { portableValue } from '../core-open/utils/portable-path.js';
import { CliError, ExitCode } from '../util/exit.js';

const REBUILD_HINT = 'Rebuild it with `vg build`.';

const SUPPORTED_SCHEMA = new Set<string>(SUPPORTED_SCHEMA_VERSIONS);

/**
 * A code map on disk cannot be loaded.
 *
 * The message is the operator-facing error: what failed, and how to rebuild.
 * It never includes file contents, parser excerpts, or any other bytes from
 * the artifact (those can carry credentials). `code` is {@link ExitCode.ERROR}
 * so a command that lets this propagate exits non-zero.
 */
export class GraphLoadError extends CliError {
  readonly isGraphLoadError = true;
  readonly kind: 'corrupt' | 'schema';

  constructor(message: string, kind: 'corrupt' | 'schema') {
    super(message, ExitCode.ERROR);
    this.name = 'GraphLoadError';
    this.kind = kind;
  }
}

function supportedSchemaList(): string {
  const versions = SUPPORTED_SCHEMA_VERSIONS;
  if (versions.length <= 1) return versions.join('');
  return `${versions.slice(0, -1).join(', ')} or ${versions[versions.length - 1]}`;
}

/** A schema token we are willing to echo. Anything else stays out of the message. */
function echoableSchema(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 32) return null;
  return /^vg-graph\/\d{1,4}\.\d{1,4}$/.test(value) ? value : null;
}

function isSupportedSchema(value: unknown): value is SupportedSchemaVersion {
  return typeof value === 'string' && SUPPORTED_SCHEMA.has(value);
}

function corruptMessage(): string {
  return `The code map is truncated or not valid JSON. ${REBUILD_HINT}`;
}

function unreadableMessage(): string {
  return `The code map could not be read. ${REBUILD_HINT}`;
}

function shapeMessage(): string {
  return `The code map is not a readable code map. ${REBUILD_HINT}`;
}

function schemaMessage(version: unknown): string {
  const echoed = echoableSchema(version);
  const got = echoed
    ? `schema \`${echoed}\``
    : 'a schema this version of vg cannot read';
  return `The code map uses ${got} (this version reads ${supportedSchemaList()}). ${REBUILD_HINT}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Accept a decoded map, or throw {@link GraphLoadError}.
 * Checks version and shape only — it does not walk nodes or edges.
 */
export function assertReadableGraph(value: unknown): VgGraph {
  if (!isPlainObject(value)) throw new GraphLoadError(shapeMessage(), 'corrupt');
  if (!isSupportedSchema(value.schemaVersion)) {
    throw new GraphLoadError(schemaMessage(value.schemaVersion), 'schema');
  }
  if (!Array.isArray(value.nodes) || !Array.isArray(value.edges)) {
    throw new GraphLoadError(shapeMessage(), 'corrupt');
  }
  return value as unknown as VgGraph;
}

/** Read failed for a reason other than "the file is not there". */
export function unreadableGraphError(): GraphLoadError {
  return new GraphLoadError(unreadableMessage(), 'corrupt');
}

/**
 * Deterministic serialization of `graph.json`.
 *
 * Object keys are sorted recursively and arrays are emitted in the (already
 * stable) order the engine produced them, so two runs over identical content
 * yield byte-identical output — the determinism contract (VG-CLI-SPEC §1.3).
 * Pretty-printed (2-space) and newline-terminated so the committed artifact is
 * human-diffable and plays well with the union merge driver.
 */
export function serializeGraph(graph: VgGraph, opts?: { compact?: boolean; root?: string }): string {
  // Compact (no pretty-print) for large maps / CI artifacts — still deterministic.
  const indent = opts?.compact ? 0 : 2;
  return `${stableStringify(portableValue(graph, opts?.root), indent)}\n`;
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

/**
 * Parse a code-map JSON document.
 *
 * Throws {@link GraphLoadError} when the text is truncated or not JSON, or
 * when the document is not a schema this version of vg can read. The message
 * names the failure and how to rebuild; it does not include the document.
 */
export function parseGraph(json: string): VgGraph {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new GraphLoadError(corruptMessage(), 'corrupt');
  }
  return assertReadableGraph(value);
}
