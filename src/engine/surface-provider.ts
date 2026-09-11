/**
 * Surface-catalog seam for the External Surface Inventory.
 *
 * The scanner in this package sees only *observations*: a package name in a
 * manifest, a hostname in a string literal, an environment-variable NAME in
 * `.env.example`, a model id passed to an SDK call, an MCP server block in
 * `.cursor/mcp.json`. Turning any of those into "this repo depends on Stripe,
 * which is a payments provider, whose icon is X, and whose API version you
 * pinned is two years old" needs the curated vendor map — and that map is not
 * in this package, by design. It is compiled into the optional relevance
 * module and reached only through this seam.
 *
 * That is also why `serviceDependencies` is produced here now: its 360-entry
 * package→vendor table used to be hardcoded in `scanners/service-dependencies.ts`,
 * which meant every new vendor needed a CLI release to reach users. It now
 * lives in one refreshable place with the rest of the catalog.
 *
 * Loading mirrors the relevance seam exactly (same module, same kill switch,
 * same override). Every failure path degrades to `null`: a scan without the
 * module still completes, just without the inventory. The module is the
 * catalog, not a dependency.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ExternalSurface, SurfaceInventory } from '../core-open/index.js';

// ── observations (what this package is allowed to know) ────────────────────

interface ObservationBase {
  file?: string;
  line?: number;
  project?: string;
}

export interface PackageObservation extends ObservationBase {
  eco: string;
  name: string;
  version?: string | null;
}

export interface HostObservation extends ObservationBase {
  host: string;
}

export interface EnvKeyObservation extends ObservationBase {
  key: string;
}

export interface ModelObservation extends ObservationBase {
  id: string;
  nearSdkImport?: boolean;
}

export interface ApiVersionObservation extends ObservationBase {
  field: string;
  value: string;
  host?: string;
}

export interface McpServerObservation extends ObservationBase {
  name: string;
  transport?: 'stdio' | 'sse' | 'http';
  command?: string;
  args?: string[];
  urlHost?: string;
  tools?: string[];
}

export interface IacResourceObservation extends ObservationBase {
  resource: string;
  host?: string;
}

/** The vendor freshness catalog, as `SurfaceCatalogClient` resolved it. */
export interface SurfaceCatalogInput {
  generatedAt?: string;
  source?: string;
  models?: unknown[];
  apis?: unknown[];
  mcp?: unknown[];
}

export interface SurfaceObservations {
  today?: string;
  /** Omit and every freshness verdict is `unknown` — never a guess. */
  catalog?: SurfaceCatalogInput;
  packages?: PackageObservation[];
  hosts?: HostObservation[];
  envKeys?: EnvKeyObservation[];
  models?: ModelObservation[];
  apiVersions?: ApiVersionObservation[];
  mcpServers?: McpServerObservation[];
  iacResources?: IacResourceObservation[];
}

/** One legacy service-dependency row, as the catalog hands it back. */
export interface LegacyServiceRow {
  bucket: string;
  name: string;
  package: string;
  version: string | null;
}

export interface SurfaceClassification {
  inventory: Omit<SurfaceInventory, 'generatedAt'>;
  serviceDependencies: LegacyServiceRow[];
}

/** One provider record, as returned by `search`. */
export interface CatalogProvider {
  id: string;
  displayName: string;
  category: string;
  iconId: string;
  homepage: string | null;
  apiVersionField: string | null;
}

export interface SurfaceCatalog {
  classify(observations: SurfaceObservations): SurfaceClassification;
  search(query: string): CatalogProvider[];
  get(providerId: string): unknown | null;
  info(): { version: string; generatedAt: string; providers: number };
}

function disabled(): boolean {
  const v = process.env.VIBGRATE_NO_KERNEL;
  return v === '1' || v === 'true';
}

/** Default install location for the optional relevance module. Kept in step
 *  with `engine/relevance-provider.ts` — one module, one directory. */
export function surfaceModuleDir(): string {
  const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return path.join(base, 'vibgrate', 'modules', 'relevance');
}

function candidatePaths(): string[] {
  const custom = process.env.VIBGRATE_RELEVANCE_PATH;
  if (custom) {
    const p = path.resolve(custom);
    try {
      if (fs.statSync(p).isDirectory()) return [path.join(p, 'index.js')];
    } catch {
      /* fall through — treat as a file path */
    }
    return [p];
  }
  return [path.join(surfaceModuleDir(), 'index.js')];
}

let cached: SurfaceCatalog | null | undefined;

/** Reset the memoized catalog (tests only). */
export function resetSurfaceCatalogCache(): void {
  cached = undefined;
}

/**
 * Load the surface catalog. Memoized per process; `null` when the kernel is
 * disabled, the module is not installed, or the installed module predates the
 * catalog. Callers treat `null` as "no inventory this run" and carry on.
 */
export async function loadSurfaceCatalog(): Promise<SurfaceCatalog | null> {
  if (cached !== undefined) return cached;
  cached = null;
  if (disabled()) return cached;
  for (const p of candidatePaths()) {
    if (!fs.existsSync(p)) continue;
    try {
      const mod = (await import(pathToFileURL(p).href)) as {
        createSurfaceCatalog?: () => SurfaceCatalog | null;
      };
      const catalog = mod.createSurfaceCatalog?.();
      if (catalog && typeof catalog.classify === 'function') {
        cached = catalog;
        return cached;
      }
    } catch {
      // A broken module must never break a scan — fall through to null.
    }
  }
  return cached;
}

// ── trust boundary ─────────────────────────────────────────────────────────

const MAX_SURFACES = 500;
const MAX_EVIDENCE_PER_SURFACE = 12;
const MAX_STRING = 200;
const MAX_SNIPPET = 80;
const KINDS = new Set(['api', 'model', 'mcp', 'saas']);
const CATALOG_SOURCES = new Set(['module', 'none']);
const CONFIDENCES = new Set(['high', 'medium', 'low']);
const STATUSES = new Set(['current', 'behind', 'deprecated', 'retired', 'unknown']);
const CATEGORIES = new Set([
  'ai', 'mcp', 'payment', 'auth', 'email', 'cloud', 'databases',
  'messaging', 'observability', 'crm', 'storage', 'search', 'other',
]);

/**
 * Credential shapes that must never reach the artifact. The kernel applies the
 * same list on its own side; this is the host-side half of the belt and braces,
 * and it runs last, so nothing gets persisted that passed only one of them.
 */
const SECRET_MARKERS = [
  'sk-', 'sk_live', 'sk_test', 'pk_live', 'rk_live', 'ghp_', 'gho_', 'ghu_', 'ghs_',
  'glpat-', 'xoxb-', 'xoxp-', 'akia', 'asia', 'bearer ', 'authorization:', '-----begin',
  'aiza', 'hf_', 'npm_', 'shpat_', 'sq0atp-', 'sq0csp-',
];

function looksSecret(value: string): boolean {
  const lower = value.toLowerCase();
  return SECRET_MARKERS.some((m) => lower.includes(m));
}

/** Printable one-line string, control characters stripped, length-capped. */
function cleanLine(raw: unknown, cap = MAX_STRING): string {
  return String(raw ?? '')
    .replace(/[\u0000-\u001F\u007F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, cap);
}

function cleanList(raw: unknown, cap: number): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    const value = cleanLine(item);
    if (value && !looksSecret(value) && !out.includes(value)) out.push(value);
    if (out.length >= cap) break;
  }
  return out;
}

function finiteInt(raw: unknown, fallback = 0): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/**
 * Enforce the trust boundary on a classification before it can reach the scan
 * artifact. The module is separately distributed code, so nothing it returns is
 * taken on faith: unknown enum values are normalised, every string is stripped
 * of control characters and length-capped, anything that still looks like a
 * credential is dropped, and the collections are bounded.
 */
export function sanitizeInventory(raw: unknown, generatedAt: string): SurfaceInventory {
  const input = (raw ?? {}) as Record<string, unknown>;
  const catalogRaw = (input.catalog ?? {}) as Record<string, unknown>;
  const countsRaw = (input.counts ?? {}) as Record<string, unknown>;
  const surfacesRaw = Array.isArray(input.surfaces) ? input.surfaces : [];

  const surfaces: ExternalSurface[] = [];
  for (const item of surfacesRaw.slice(0, MAX_SURFACES)) {
    const s = (item ?? {}) as Record<string, unknown>;
    const providerRaw = (s.provider ?? {}) as Record<string, unknown>;
    const providerId = cleanLine(providerRaw.id, 80);
    const kind = cleanLine(s.kind, 16);
    const detectedId = cleanLine(s.detectedId, 160);
    if (!providerId || !KINDS.has(kind) || !detectedId) continue;

    const freshRaw = (s.freshness ?? {}) as Record<string, unknown>;
    const status = cleanLine(freshRaw.status, 16);
    const metaRaw = (s.metadata ?? {}) as Record<string, unknown>;
    const category = cleanLine(providerRaw.category, 24);

    const evidence = (Array.isArray(s.evidence) ? s.evidence : [])
      .slice(0, MAX_EVIDENCE_PER_SURFACE)
      .map((e) => {
        const ev = (e ?? {}) as Record<string, unknown>;
        const spanRaw = (ev.span ?? null) as Record<string, unknown> | null;
        const snippet = cleanLine(ev.snippet, MAX_SNIPPET);
        const confidence = Number(ev.confidence);
        return {
          signal: cleanLine(ev.signal, 24) as ExternalSurface['evidence'][number]['signal'],
          file: cleanLine(ev.file, MAX_STRING),
          ...(spanRaw ? { span: { start: finiteInt(spanRaw.start), end: finiteInt(spanRaw.end) } } : {}),
          ...(snippet && !looksSecret(snippet) ? { snippet } : {}),
          confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0,
        };
      })
      .filter((e) => e.signal && e.file);

    const metadata = {
      ...(Array.isArray(metaRaw.hosts) ? { hosts: cleanList(metaRaw.hosts, 32) } : {}),
      ...(Array.isArray(metaRaw.envKeys) ? { envKeys: cleanList(metaRaw.envKeys, 32) } : {}),
      ...(Array.isArray(metaRaw.packages) ? { packages: cleanList(metaRaw.packages, 64) } : {}),
      ...(metaRaw.sdkPackage ? { sdkPackage: cleanLine(metaRaw.sdkPackage, 160) } : {}),
      ...('sdkVersion' in metaRaw ? { sdkVersion: metaRaw.sdkVersion == null ? null : cleanLine(metaRaw.sdkVersion, 64) } : {}),
      ...(metaRaw.mcpCommand ? { mcpCommand: cleanLine(metaRaw.mcpCommand, 160) } : {}),
      ...(Array.isArray(metaRaw.mcpArgs) ? { mcpArgs: cleanList(metaRaw.mcpArgs, 24) } : {}),
      ...(Array.isArray(metaRaw.mcpTools) ? { mcpTools: cleanList(metaRaw.mcpTools, 64) } : {}),
      ...(metaRaw.transport ? { transport: cleanLine(metaRaw.transport, 8) as 'stdio' | 'sse' | 'http' } : {}),
      ...(metaRaw.mcpUrlHost ? { mcpUrlHost: cleanLine(metaRaw.mcpUrlHost, 160) } : {}),
    };

    surfaces.push({
      id: cleanLine(s.id, 64),
      kind: kind as ExternalSurface['kind'],
      provider: {
        id: providerId,
        displayName: cleanLine(providerRaw.displayName, 120) || providerId,
        iconId: cleanLine(providerRaw.iconId, 120) || providerId,
        category: (CATEGORIES.has(category) ? category : 'other') as ExternalSurface['provider']['category'],
        ...(providerRaw.homepage ? { homepage: cleanLine(providerRaw.homepage, MAX_STRING) } : {}),
      },
      detectedId,
      displayName: cleanLine(s.displayName, 160) || detectedId,
      version: s.version == null ? null : cleanLine(s.version, 64),
      freshness: {
        // An unrecognised status must never read as reassurance — it degrades
        // to `unknown`, not to `current`.
        status: (STATUSES.has(status) ? status : 'unknown') as ExternalSurface['freshness']['status'],
        detected: freshRaw.detected == null ? null : cleanLine(freshRaw.detected, 160),
        latest: freshRaw.latest == null ? null : cleanLine(freshRaw.latest, 160),
        ...(freshRaw.latestAt ? { latestAt: cleanLine(freshRaw.latestAt, 32) } : {}),
        alternatives: cleanList(freshRaw.alternatives, 8),
        // The source the host actually resolved. An unrecognised value degrades
        // to `none` rather than to a source that implies a freshness we did
        // not have.
        catalogSource: (CATALOG_SOURCES.has(cleanLine(freshRaw.catalogSource, 12))
          ? cleanLine(freshRaw.catalogSource, 12)
          : 'none') as ExternalSurface['freshness']['catalogSource'],
        ...(freshRaw.catalogGeneratedAt ? { catalogGeneratedAt: cleanLine(freshRaw.catalogGeneratedAt, 32) } : {}),
      },
      confidence: (CONFIDENCES.has(cleanLine(s.confidence, 8)) ? cleanLine(s.confidence, 8) : 'low') as ExternalSurface['confidence'],
      evidence,
      callSites: finiteInt(s.callSites),
      projects: cleanList(s.projects, 64),
      ...(Array.isArray(s.aliases) && s.aliases.length ? { aliases: cleanList(s.aliases, 8) } : {}),
      ...(Object.keys(metadata).length ? { metadata } : {}),
    });
  }

  surfaces.sort(
    (a, b) =>
      a.kind.localeCompare(b.kind) ||
      a.provider.id.localeCompare(b.provider.id) ||
      a.detectedId.localeCompare(b.detectedId),
  );

  return {
    schema: 'vg-surfaces/1.0',
    generatedAt,
    catalog: {
      source: (CATALOG_SOURCES.has(cleanLine(catalogRaw.source, 12))
        ? cleanLine(catalogRaw.source, 12)
        : 'none') as SurfaceInventory['catalog']['source'],
      ...(catalogRaw.generatedAt ? { generatedAt: cleanLine(catalogRaw.generatedAt, 32) } : {}),
      ...(catalogRaw.version ? { version: cleanLine(catalogRaw.version, 32) } : {}),
      stale: catalogRaw.stale !== false,
    },
    counts: {
      providers: finiteInt(countsRaw.providers),
      apis: finiteInt(countsRaw.apis),
      models: finiteInt(countsRaw.models),
      mcpServers: finiteInt(countsRaw.mcpServers),
      saas: finiteInt(countsRaw.saas),
      behind: finiteInt(countsRaw.behind),
      deprecated: finiteInt(countsRaw.deprecated),
      retired: finiteInt(countsRaw.retired),
      unknown: finiteInt(countsRaw.unknown),
    },
    surfaces,
    unknownHosts: cleanList(input.unknownHosts, 50),
  };
}
