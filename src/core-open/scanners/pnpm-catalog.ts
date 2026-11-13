/**
 * pnpm catalogs (`pnpm-workspace.yaml`).
 *
 * A workspace can pin shared ranges once and point each package.json at them
 * with `catalog:` (the default catalog), `catalog:default`, or `catalog:<name>`.
 * The default catalog is the top-level `catalog` map, or `catalogs.default`
 * when that map is absent. pnpm accepts one of those, not both; when both are
 * present the top-level `catalog` map wins and named catalogs are still read.
 *
 * Clean-room: parsed from pnpm's public workspace file with the `yaml` package.
 */
import { parse as parseYaml } from 'yaml';

export interface PnpmCatalogs {
  /** Catalog name → package name → specifier. The default catalog is `default`. */
  readonly byName: ReadonlyMap<string, ReadonlyMap<string, string>>;
}

const EMPTY_BY_NAME: PnpmCatalogs['byName'] = new Map();

export const EMPTY_PNPM_CATALOGS: PnpmCatalogs = { byName: EMPTY_BY_NAME };

export type PnpmCatalogResolution =
  | { kind: 'not-catalog' }
  | { kind: 'resolved'; spec: string }
  | { kind: 'missing' };

const CATALOG_PROTOCOL = 'catalog:';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Package name → specifier. Null when `value` is not a catalog map. */
function catalogEntries(value: unknown): Map<string, string> | null {
  if (!isRecord(value)) return null;
  const out = new Map<string, string>();
  for (const [name, spec] of Object.entries(value)) {
    if (typeof spec !== 'string') continue;
    const trimmed = spec.trim();
    if (!trimmed) continue;
    out.set(name, trimmed);
  }
  return out;
}

function namedCatalogs(value: unknown): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  if (!isRecord(value)) return out;
  for (const [name, body] of Object.entries(value)) {
    const entries = catalogEntries(body);
    if (!entries) continue;
    out.set(name, entries);
  }
  return out;
}

/** Read `catalog` and `catalogs` from a `pnpm-workspace.yaml` document. */
export function parsePnpmCatalogs(text: string): PnpmCatalogs {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch {
    return EMPTY_PNPM_CATALOGS;
  }
  if (!isRecord(doc)) return EMPTY_PNPM_CATALOGS;

  const top = catalogEntries(doc.catalog);
  const named = namedCatalogs(doc.catalogs);
  const byName = new Map<string, ReadonlyMap<string, string>>();
  const defaults = top ?? named.get('default');
  if (defaults) byName.set('default', defaults);
  for (const [name, entries] of named) {
    if (name === 'default') continue;
    byName.set(name, entries);
  }
  return byName.size > 0 ? { byName } : EMPTY_PNPM_CATALOGS;
}

/**
 * Resolve one package.json specifier against catalogs loaded for the scan.
 * `catalog:` and `catalog:default` use the default catalog. Any other
 * `catalog:<name>` uses that named catalog. The returned specifier is what
 * drift and lockfile lookup should see; the manifest text stays unchanged.
 */
export function resolvePnpmCatalogSpec(
  packageName: string,
  spec: string,
  catalogs: PnpmCatalogs,
): PnpmCatalogResolution {
  const trimmed = spec.trim();
  if (!trimmed.startsWith(CATALOG_PROTOCOL)) return { kind: 'not-catalog' };
  const name = trimmed.slice(CATALOG_PROTOCOL.length).trim() || 'default';
  const resolved = catalogs.byName.get(name)?.get(packageName);
  if (!resolved) return { kind: 'missing' };
  return { kind: 'resolved', spec: resolved };
}
