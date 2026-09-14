import { discoverDocs } from '../engine/docs-ingest.js';
import { extractToolchainDrafts } from '../engine/toolchain/index.js';
import type { ToolchainNodeDraft } from '../engine/toolchain/types.js';
import { FACT_DOCUMENT_MAX_FACTS, type Fact, type FactDocument, type FactKind } from './types.js';

/**
 * The fact builder: discovered toolchain files → node drafts → a frozen,
 * sorted `vg.facts.v1` document (facts.md §2).
 *
 * It contains no rule. It projects what the extractors already declared
 * (their `attrs`), binds each fact to the node id the graph gives the same
 * draft, sorts, caps and freezes. Same tree in → same document out, on every
 * machine: discovery is sorted, extraction is pure, and nothing here reads a
 * clock or the environment.
 */

/** Draft signature → fact kind (facts.md §2.1). Drafts with any other signature are not facts. */
const KIND_BY_SIGNATURE: Readonly<Record<string, FactKind>> = {
  'terraform.resource': 'tf.resource',
  'terraform.data': 'tf.resource',
  'terraform.module': 'tf.module',
  'terraform.provider': 'tf.provider',
  'terraform.required_provider': 'tf.provider',
  'dockerfile.stage': 'docker.stage',
  'helm.chart': 'helm.chart',
};

/** The fact kind of a draft, or null when the draft is not a fact source. */
export function factKindOf(draft: Pick<ToolchainNodeDraft, 'signature' | 'kind'>): FactKind | null {
  const signature = draft.signature ?? '';
  const mapped = KIND_BY_SIGNATURE[signature];
  if (mapped) return mapped;
  // Every Kubernetes object draft (`k8s.<Kind>`) is a fact; the per-container
  // image drafts (`k8s.image`) are not — they carry no projection.
  if (signature.startsWith('k8s.') && (draft.kind === 'workload' || draft.kind === 'resource')) return 'k8s.object';
  return null;
}

// ── Attribute caps (facts.md §2 "Caps"), enforced once more at the document ──
// boundary so the guarantee does not depend on every extractor remembering.

const ATTRS_MAX_DEPTH = 6;
const ATTRS_MAX_KEYS = 64;
const ATTRS_MAX_ITEMS = 64;
const ATTRS_MAX_STRING = 256;

/**
 * Bound a projection: strings ≤ 256, ≤ 64 keys per object, ≤ 64 items per
 * array, depth ≤ 6 (deeper containers are emptied). Identity on a projection
 * that already respects the caps, so extractor output passes through untouched.
 */
export function boundAttrs(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return value.length > ATTRS_MAX_STRING ? value.slice(0, ATTRS_MAX_STRING) : value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value !== 'object') return null;
  if (depth >= ATTRS_MAX_DEPTH) return Array.isArray(value) ? [] : {};
  if (Array.isArray(value)) return value.slice(0, ATTRS_MAX_ITEMS).map((item) => boundAttrs(item, depth + 1));
  const out: Record<string, unknown> = {};
  let keys = 0;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (item === undefined) continue;
    if (keys >= ATTRS_MAX_KEYS) break;
    out[key] = boundAttrs(item, depth + 1);
    keys++;
  }
  return out;
}

/** Sort order of the document: (kind, path, address), binary string order. */
function byKindPathAddress(a: Fact, b: Fact): number {
  return (
    (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0) ||
    (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) ||
    (a.address < b.address ? -1 : a.address > b.address ? 1 : 0)
  );
}

export interface BuildFactDocumentOptions {
  root: string;
  exclude?: string[];
  /** Pack ids to request, e.g. `['iac-cis-v1']`. */
  packs: readonly string[];
}

/**
 * Build the `vg.facts.v1` document for a tree. Never throws on a bad file —
 * discovery and extraction already degrade per file. The result is frozen:
 * it is handed to the module as is and must not be mutated or persisted.
 */
export async function buildFactDocument(options: BuildFactDocumentOptions): Promise<FactDocument> {
  const docs = discoverDocs({ root: options.root, exclude: options.exclude });
  const drafts = await extractToolchainDrafts(docs);

  const facts: Fact[] = [];
  const seen = new Set<string>();
  for (const { rel, draft, nodeId } of drafts) {
    if (!draft.attrs) continue;
    const kind = factKindOf(draft);
    if (!kind) continue;
    const key = `${kind} ${rel} ${draft.qualifiedName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (facts.length >= FACT_DOCUMENT_MAX_FACTS) break;
    const line = draft.span.start;
    facts.push({
      kind,
      path: rel,
      ...(Number.isInteger(line) && line > 0 ? { line } : {}),
      address: draft.qualifiedName,
      node: nodeId,
      attrs: boundAttrs(draft.attrs) as Record<string, unknown>,
    });
  }
  facts.sort(byKindPathAddress);

  return Object.freeze({
    schema: 'vg.facts.v1',
    packs: [...options.packs],
    facts: Object.freeze(facts) as Fact[],
  });
}
