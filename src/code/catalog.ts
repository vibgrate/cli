/**
 * Live model catalog for the `vg code` guided picker (VG-CLI-CODE §8).
 *
 * The guided flow offers the developer the current top providers and models
 * without us hard-coding a list that goes stale. OpenRouter publishes a public,
 * key-free catalog at `/api/v1/models`; we fetch it, group by provider, rank
 * coding-friendly models first, and cache it per-user with a TTL so repeat runs
 * are instant and offline runs still work. If the network and cache both fail we
 * fall back to a tiny curated provider list plus the always-available
 * "enter a model slug yourself" escape hatch — the picker is never empty.
 *
 * Pure over its injected `fetch`, `now`, and cache, so the parse/group/rank
 * logic is unit-testable with no network.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface CatalogModel {
  /** Full slug, e.g. `anthropic/claude-3.5-sonnet`. */
  id: string;
  name: string;
  /** Provider segment, e.g. `anthropic`. */
  provider: string;
  contextLength?: number;
  /** USD per 1M prompt tokens (derived from OpenRouter's per-token price). */
  promptPricePerM?: number;
  completionPricePerM?: number;
}

export interface ProviderGroup {
  /** Provider id, e.g. `anthropic`. */
  id: string;
  /** Friendly label, e.g. `Anthropic (Claude)`. */
  label: string;
  models: CatalogModel[];
}

export interface Catalog {
  providers: ProviderGroup[];
  /** true when served from network, false when from cache or the curated fallback. */
  fresh: boolean;
  source: 'network' | 'cache' | 'fallback';
}

/** Provider display names + the order we surface them (the "top providers" list). */
const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic (Claude)',
  openai: 'OpenAI (GPT)',
  'x-ai': 'xAI (Grok)',
  google: 'Google (Gemini)',
  'meta-llama': 'Meta (Llama)',
  deepseek: 'DeepSeek',
  mistralai: 'Mistral',
  qwen: 'Qwen',
};
const FEATURED_ORDER = Object.keys(PROVIDER_LABELS);

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
/** Cache freshness window: a day is plenty; model lists move slowly. */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export interface FetchCatalogOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Bypass and refresh from network. */
  noCache?: boolean;
  /** Never touch the network (offline / --local): cache or curated only. */
  offline?: boolean;
  timeoutMs?: number;
}

/** The per-user catalog cache file (shared across repos, like the model cache). */
export function catalogCachePath(): string {
  const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return path.join(base, 'vibgrate', 'catalog', 'openrouter-models.json');
}

export async function fetchCatalog(options: FetchCatalogOptions = {}): Promise<Catalog> {
  const now = options.now ?? (() => 0);
  const fetchImpl = options.fetchImpl ?? fetch;

  // Serve from a warm cache when allowed.
  if (!options.noCache) {
    const cached = readCache();
    if (cached && (options.offline || now() - cached.ts < CACHE_TTL_MS)) {
      return { providers: groupModels(cached.models), fresh: false, source: 'cache' };
    }
  }
  if (options.offline) {
    const cached = readCache();
    if (cached) return { providers: groupModels(cached.models), fresh: false, source: 'cache' };
    return { providers: curatedFallback(), fresh: false, source: 'fallback' };
  }

  // Fetch fresh.
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 8000);
    let raw: unknown;
    try {
      const res = await fetchImpl(OPENROUTER_MODELS_URL, { signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      raw = await res.json();
    } finally {
      clearTimeout(timer);
    }
    const models = parseModels(raw);
    if (models.length === 0) throw new Error('empty catalog');
    writeCache(models, now());
    return { providers: groupModels(models), fresh: true, source: 'network' };
  } catch {
    // Network failed → cache → curated.
    const cached = readCache();
    if (cached) return { providers: groupModels(cached.models), fresh: false, source: 'cache' };
    return { providers: curatedFallback(), fresh: false, source: 'fallback' };
  }
}

/** Parse OpenRouter's `/models` payload into our shape (defensive about fields). */
export function parseModels(raw: unknown): CatalogModel[] {
  const data = (raw as { data?: unknown[] })?.data;
  if (!Array.isArray(data)) return [];
  const out: CatalogModel[] = [];
  for (const entry of data) {
    const e = entry as {
      id?: unknown;
      name?: unknown;
      context_length?: unknown;
      pricing?: { prompt?: unknown; completion?: unknown };
    };
    if (typeof e.id !== 'string' || !e.id.includes('/')) continue;
    const provider = e.id.split('/')[0];
    out.push({
      id: e.id,
      name: typeof e.name === 'string' ? e.name : e.id,
      provider,
      contextLength: numeric(e.context_length),
      promptPricePerM: perMillion(e.pricing?.prompt),
      completionPricePerM: perMillion(e.pricing?.completion),
    });
  }
  return out;
}

/** Group models by provider, featured providers first, coding models first within each. */
export function groupModels(models: CatalogModel[]): ProviderGroup[] {
  const byProvider = new Map<string, CatalogModel[]>();
  for (const m of models) {
    const list = byProvider.get(m.provider) ?? [];
    list.push(m);
    byProvider.set(m.provider, list);
  }
  const groups: ProviderGroup[] = [];
  for (const [id, list] of byProvider) {
    groups.push({ id, label: PROVIDER_LABELS[id] ?? titleCase(id), models: list.sort(rankModels) });
  }
  // Featured providers in our order first, then the rest alphabetically.
  groups.sort((a, b) => {
    const ia = FEATURED_ORDER.indexOf(a.id);
    const ib = FEATURED_ORDER.indexOf(b.id);
    if (ia !== -1 || ib !== -1) return (ia === -1 ? 1e9 : ia) - (ib === -1 ? 1e9 : ib);
    return a.label.localeCompare(b.label);
  });
  return groups;
}

/** Coding-oriented models first, then larger context, then name — a helpful default order. */
function rankModels(a: CatalogModel, b: CatalogModel): number {
  const ca = isCoding(a) ? 0 : 1;
  const cb = isCoding(b) ? 0 : 1;
  if (ca !== cb) return ca - cb;
  const la = a.contextLength ?? 0;
  const lb = b.contextLength ?? 0;
  if (la !== lb) return lb - la;
  return a.id.localeCompare(b.id);
}

function isCoding(m: CatalogModel): boolean {
  return /cod(e|er|ing)/i.test(m.id) || /cod(e|er|ing)/i.test(m.name);
}

/** Top N providers (the guided picker's first screen). */
export function topProviders(catalog: Catalog, n = 6): ProviderGroup[] {
  return catalog.providers.slice(0, n);
}

interface CacheShape {
  ts: number;
  models: CatalogModel[];
}

function readCache(): CacheShape | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(catalogCachePath(), 'utf8')) as CacheShape;
    if (Array.isArray(parsed.models) && typeof parsed.ts === 'number') return parsed;
  } catch {
    /* no cache */
  }
  return null;
}

function writeCache(models: CatalogModel[], ts: number): void {
  try {
    const file = catalogCachePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ts, models }));
  } catch {
    /* cache is best-effort */
  }
}

/**
 * A minimal, honestly-labelled offline fallback: just the provider names, so the
 * picker still works with no network and no cache. Model ids are intentionally
 * NOT hard-coded (they go stale) — the flow always offers "enter a model slug".
 */
function curatedFallback(): ProviderGroup[] {
  return FEATURED_ORDER.map((id) => ({ id, label: PROVIDER_LABELS[id], models: [] }));
}

function numeric(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : undefined;
}

/** OpenRouter prices are USD *per token* as strings; convert to per-million. */
function perMillion(v: unknown): number | undefined {
  const n = numeric(v);
  if (n === undefined) return undefined;
  return Math.round(n * 1_000_000 * 1000) / 1000;
}

function titleCase(id: string): string {
  return id.replace(/[-_]/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase());
}
