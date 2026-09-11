// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
/**
 * Builds the {@link VendorSurfaceCatalog} from vendor sources.
 *
 * Pure and dependency-free on purpose: the API Worker calls it on a cache miss,
 * the weekly refresh job calls it to regenerate the bundled snapshot, and both
 * therefore produce byte-identical catalogs from the same inputs. Fetching is
 * the caller's job — this file only normalises and merges.
 *
 * The one rule that shapes all of it: **a roster cannot deprecate a model.**
 * A list of what a vendor serves today tells you what exists; a model missing
 * from it might be retired, or might just not be carried by that aggregator.
 * So the roster may only ever contribute existence and recency, and every
 * "deprecated" / "retired" / "use this instead" claim comes from the curated
 * announcements in `curated.ts`, which the merge preserves verbatim.
 */
import type { VendorApiEntry, VendorMcpEntry, VendorModelEntry, VendorSurfaceCatalog } from './types.js';

/**
 * OpenRouter namespaces models as `vendor/model`. Map the segments whose
 * spelling differs from the detection slug; anything else passes through
 * unchanged.
 *
 * Deliberately NOT an allowlist. OpenRouter's job here is to catch the vendors
 * and models our own corpus has not caught up with yet, so dropping namespaces
 * we do not recognise would discard exactly the rows we fetched it for. A slug
 * the provider brain does not carry is simply inert until the brain gains it —
 * the kernel drops catalog rows whose provider it cannot resolve.
 */
const OPENROUTER_NAMESPACE_TO_PROVIDER: Readonly<Record<string, string>> = {
  openai: 'openai',
  anthropic: 'anthropic',
  google: 'google-gemini',
  'x-ai': 'x-ai',
  mistralai: 'mistral',
  deepseek: 'deepseek',
  cohere: 'cohere',
  'meta-llama': 'meta-llama',
  qwen: 'qwen',
  amazon: 'bedrock',
};

/** Models kept per provider. The roster's long tail is noise for this purpose. */
const MAX_MODELS_PER_PROVIDER = 40;

/** One row of OpenRouter's `GET /api/v1/models` response, loosely typed. */
export interface OpenRouterModelRow {
  id?: unknown;
  name?: unknown;
  /** Unix seconds. */
  created?: unknown;
}

/**
 * One row of the website's `data/json/models.json` — Vibgrate's own curated
 * model corpus, already maintained for the public model pages.
 *
 * It is the primary roster: 450+ models across 80+ provider slugs, every one
 * with a release date, versus an aggregator's partial view of what it happens
 * to route. It carries no deprecation field, though, so it can only ever
 * contribute existence and recency — retirements still come from `curated.ts`.
 */
export interface WebsiteModelRow {
  slug?: unknown;
  name?: unknown;
  provider_slug?: unknown;
  release_date?: unknown;
}

export interface VendorSurfaceSources {
  /**
   * An already-built roster to refresh on top of.
   *
   * The API Worker uses this: the website corpus is a repo file it cannot read,
   * but the roster compiled into the relevance package already carries that
   * corpus, so the Worker merges today's live roster over the shipped one and
   * serves something strictly fresher without needing the repo.
   */
  baseModels?: readonly VendorModelEntry[] | null;
  /**
   * The curated vendor announcements, read from the one place they live:
   * `packages/vibgrate-relevance/data/surfaces/surfaces.json`.
   *
   * They are an argument, never a bundled default. This package is compiled
   * into the public CLI, and a copy here would ship the curated set in every
   * published npm tarball — which is exactly what it used to do.
   */
  curatedModels?: readonly VendorModelEntry[] | null;
  /** Curated API versions, from the same file. */
  curatedApis?: readonly VendorApiEntry[] | null;
  /** `packages/vibgrate-website/data/json/models.json` — the primary roster. */
  websiteModels?: readonly WebsiteModelRow[] | null;
  /** Body of OpenRouter's `GET /api/v1/models`, used to fill gaps. */
  openRouterModels?: { data?: unknown } | null;
  /** npm `latest` version keyed by MCP server package name. */
  mcpLatestByPackage?: Readonly<Record<string, string>> | null;
}

/**
 * The website's provider slugs are its own editorial vocabulary; the surface
 * brain's are the detection slugs. Map the ones that differ so a roster row
 * lands on the same provider a detected package would. An unmapped slug falls
 * through unchanged, which is correct for the majority that already agree.
 */
const WEBSITE_SLUG_TO_PROVIDER: Readonly<Record<string, string>> = {
  google: 'google-gemini',
  'google-deepmind': 'google-gemini',
  xai: 'x-ai',
  'mistral-ai': 'mistral',
  amazon: 'bedrock',
  microsoft: 'azure-openai',
  huggingface: 'hugging-face',
};

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** `anthropic/claude-3.5-sonnet:beta` → `{ providerId, modelId }`. */
function splitOpenRouterId(rawId: string): { providerId: string; modelId: string } | null {
  const [namespace, ...rest] = rawId.split('/');
  if (!namespace || rest.length === 0) return null;
  // OpenRouter prefixes alias/variant namespaces with `~` (`~anthropic`).
  // Left alone they mint a phantom provider alongside the real one.
  const key = namespace.toLowerCase().replace(/^~+/, '');
  if (!key) return null;
  const providerId = OPENROUTER_NAMESPACE_TO_PROVIDER[key] ?? key;
  // Strip a variant suffix (`:beta`, `:free`) — it is a routing detail of the
  // aggregator, not part of the id a vendor's own API accepts.
  const modelId = rest.join('/').split(':')[0].trim().toLowerCase();
  return modelId ? { providerId, modelId } : null;
}

/**
 * Normalise Vibgrate's own model corpus into catalog rows.
 *
 * Every row carries a release date, so unlike an aggregator roster this source
 * can always support the dated comparison the `behind` verdict requires.
 */
export function modelsFromWebsiteCorpus(rows: readonly WebsiteModelRow[] | null | undefined): VendorModelEntry[] {
  const byProvider = new Map<string, Array<{ entry: VendorModelEntry; released: string }>>();
  for (const row of rows ?? []) {
    const slug = asString(row?.slug)?.toLowerCase();
    const rawProvider = asString(row?.provider_slug)?.toLowerCase();
    if (!slug || !rawProvider) continue;
    const providerId = WEBSITE_SLUG_TO_PROVIDER[rawProvider] ?? rawProvider;
    const released = asString(row?.release_date)?.slice(0, 10) ?? '';
    const entry: VendorModelEntry = {
      providerId,
      modelId: slug,
      displayName: asString(row?.name) ?? slug,
      ...(released ? { releasedAt: released } : {}),
      origin: 'vibgrate-models',
    };
    const list = byProvider.get(providerId) ?? [];
    if (!list.some((existing) => existing.entry.modelId === entry.modelId)) list.push({ entry, released });
    byProvider.set(providerId, list);
  }

  const out: VendorModelEntry[] = [];
  for (const [, list] of [...byProvider.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    list.sort((a, b) => b.released.localeCompare(a.released) || a.entry.modelId.localeCompare(b.entry.modelId));
    for (const item of list.slice(0, MAX_MODELS_PER_PROVIDER)) out.push(item.entry);
  }
  return out;
}

/** Normalise the roster into model rows, newest first within each provider. */
export function modelsFromOpenRouter(body: { data?: unknown } | null | undefined): VendorModelEntry[] {
  const rows = Array.isArray(body?.data) ? (body.data as OpenRouterModelRow[]) : [];
  const byProvider = new Map<string, Array<{ entry: VendorModelEntry; created: number }>>();

  for (const row of rows) {
    const rawId = asString(row?.id);
    if (!rawId) continue;
    const split = splitOpenRouterId(rawId);
    if (!split) continue;
    const created = typeof row?.created === 'number' && Number.isFinite(row.created) ? row.created : 0;
    const entry: VendorModelEntry = {
      providerId: split.providerId,
      modelId: split.modelId,
      displayName: asString(row?.name) ?? split.modelId,
      ...(created > 0 ? { releasedAt: new Date(created * 1000).toISOString().slice(0, 10) } : {}),
      origin: 'openrouter',
    };
    const list = byProvider.get(split.providerId) ?? [];
    // The roster can list the same model twice under different variants.
    if (!list.some((existing) => existing.entry.modelId === entry.modelId)) list.push({ entry, created });
    byProvider.set(split.providerId, list);
  }

  const out: VendorModelEntry[] = [];
  for (const [, list] of [...byProvider.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    list.sort((a, b) => b.created - a.created || a.entry.modelId.localeCompare(b.entry.modelId));
    for (const item of list.slice(0, MAX_MODELS_PER_PROVIDER)) out.push(item.entry);
  }
  return out;
}

/**
 * Model ids that name a specialism rather than a provider's general-purpose
 * line: safety classifiers, embedding and rerank models, speech and image
 * models. They ship on their own cadence, so the newest of them is routinely
 * newer than the newest chat model — and "you are behind llama-guard" is not a
 * statement anyone wants.
 *
 * Matched on the id because it has to survive the merge: our own corpus tags
 * these with `capabilities`, but rows filled in from an aggregator carry no
 * such field, and the flagship is chosen once across all sources.
 */
const SPECIALIST_MODEL_RE =
  /(?:^|[-_/])(?:guard|guardrail|shield|moderat\w*|embed\w*|rerank\w*|tts|stt|whisper|transcribe|speech|audio|voice|image|images|vision-only|ocr|video|diffusion)(?:[-_/]|\d|$)/;

export function isSpecialistModelId(modelId: string): boolean {
  return SPECIALIST_MODEL_RE.test(modelId.toLowerCase());
}

/**
 * Mark exactly one newest model per provider, across every merged source.
 *
 * This runs once, after merging, and it has to: each source ranks only what it
 * knows, so letting them each flag a winner would leave two "newest" rows for
 * any provider both cover — and the one the kernel happened to read first would
 * decide the verdict.
 *
 * Only a dated row can win. With no date there is no defensible "newest", so no
 * row is marked and every comparison against that provider stays `unknown`
 * rather than resting on an arbitrary tie-break. A deprecated or retired model
 * can never be the newest, whatever its date says.
 */
export function markNewestPerProvider(models: readonly VendorModelEntry[]): VendorModelEntry[] {
  const winners = new Map<string, string>();
  for (const m of models) {
    if (!m.releasedAt || m.deprecated || m.retired) continue;
    if (isSpecialistModelId(m.modelId)) continue;
    const currentId = winners.get(m.providerId);
    const current = currentId ? models.find((x) => x.providerId === m.providerId && x.modelId === currentId) : undefined;
    if (!current || (current.releasedAt ?? '') < m.releasedAt) winners.set(m.providerId, m.modelId);
  }
  return models.map((m) => {
    const isNewest = winners.get(m.providerId) === m.modelId;
    if (isNewest) return { ...m, latestForFamily: true };
    // Strip any flag an upstream layer set, so exactly one row carries it.
    if (m.latestForFamily) {
      const { latestForFamily: _dropped, ...rest } = m;
      return rest;
    }
    return m;
  });
}

/**
 * Merge curated announcements over a generated roster.
 *
 * Curated rows win outright on `(providerId, modelId)` — they carry the
 * retirements a roster structurally cannot express. A curated row for a model
 * the roster no longer lists is still kept: that is precisely the case where
 * the user's code pins something the vendor has withdrawn, which is the most
 * valuable row in the catalog.
 */
export function mergeModels(
  generated: readonly VendorModelEntry[],
  curated: readonly VendorModelEntry[] = [],
): VendorModelEntry[] {
  const key = (m: VendorModelEntry): string => `${m.providerId}\u0000${m.modelId}`;
  const merged = new Map<string, VendorModelEntry>();
  for (const row of generated) merged.set(key(row), row);
  for (const row of curated) {
    const existing = merged.get(key(row));
    // Keep the roster's release date when the curated row does not state one —
    // the curated row is authoritative about status, not about dates.
    merged.set(key(row), existing?.releasedAt && !row.releasedAt ? { ...row, releasedAt: existing.releasedAt } : row);
  }
  return [...merged.values()].sort(
    (a, b) => a.providerId.localeCompare(b.providerId) || a.modelId.localeCompare(b.modelId),
  );
}

function mergeMcp(
  latestByPackage: Readonly<Record<string, string>> | null | undefined,
  curated: readonly VendorMcpEntry[] = [],
): VendorMcpEntry[] {
  const merged = new Map<string, VendorMcpEntry>();
  for (const row of curated) merged.set(row.package, row);
  for (const [pkg, version] of Object.entries(latestByPackage ?? {})) {
    const latestVersion = asString(version);
    if (!latestVersion) continue;
    const existing = merged.get(pkg);
    merged.set(pkg, {
      providerId: existing?.providerId ?? 'mcp-sdk',
      package: pkg,
      latestVersion,
      ...(existing?.defaultCommand ? { defaultCommand: existing.defaultCommand } : {}),
      ...(existing?.defaultArgs ? { defaultArgs: existing.defaultArgs } : {}),
      origin: 'openrouter',
    });
  }
  return [...merged.values()].sort((a, b) => a.package.localeCompare(b.package));
}

/**
 * Build the catalog. `generatedAt` is supplied by the caller so the result is a
 * pure function of its inputs and the weekly job's output can be diffed.
 */
export function buildVendorSurfaceCatalog(
  sources: VendorSurfaceSources,
  generatedAt: string,
): VendorSurfaceCatalog {
  // Three layers, least authoritative first. The aggregator only ever adds
  // providers or models our own corpus has not covered yet; where both know a
  // model, ours wins because its dates are editorially maintained.
  // Layers, least authoritative first: the aggregator roster, then our own
  // corpus (or a prior catalog carrying it), then the curated announcements.
  const roster = mergeModels(
    modelsFromOpenRouter(sources.openRouterModels),
    modelsFromWebsiteCorpus(sources.websiteModels),
  );
  const withBase = sources.baseModels?.length ? mergeModels(roster, sources.baseModels) : roster;
  const models = markNewestPerProvider(mergeModels(withBase, sources.curatedModels ?? []));
  const mcp = mergeMcp(sources.mcpLatestByPackage);
  const apis: VendorApiEntry[] = [...(sources.curatedApis ?? [])].sort(
    (a, b) => a.providerId.localeCompare(b.providerId) || a.apiId.localeCompare(b.apiId),
  );

  const usedSources: string[] = [];
  if (sources.curatedModels?.length || apis.length) usedSources.push('vibgrate-curated');
  if (models.some((m) => m.origin === 'vibgrate-models')) usedSources.push('vibgrate-models');
  if (models.some((m) => m.origin === 'openrouter')) usedSources.push('openrouter');
  if (mcp.some((m) => m.origin === 'openrouter')) usedSources.push('npm');

  return { generatedAt: generatedAt.slice(0, 10), sources: usedSources, models, apis, mcp };
}

/** Shape check for anything arriving over the wire or off disk. */
export function isVendorSurfaceCatalog(value: unknown): value is VendorSurfaceCatalog {
  const c = value as VendorSurfaceCatalog | null;
  return (
    !!c &&
    typeof c === 'object' &&
    typeof c.generatedAt === 'string' &&
    Array.isArray(c.models) &&
    Array.isArray(c.apis) &&
    Array.isArray(c.mcp)
  );
}

/** MCP server packages the weekly job asks npm about. */
export const TRACKED_MCP_PACKAGES: readonly string[] = [
  '@modelcontextprotocol/server-github',
  '@modelcontextprotocol/server-gitlab',
  '@modelcontextprotocol/server-slack',
  '@modelcontextprotocol/server-postgres',
  '@modelcontextprotocol/server-sentry',
  '@modelcontextprotocol/server-filesystem',
  '@modelcontextprotocol/server-memory',
  '@modelcontextprotocol/server-sequential-thinking',
  '@modelcontextprotocol/server-brave-search',
  '@modelcontextprotocol/server-google-maps',
  '@modelcontextprotocol/sdk',
];
