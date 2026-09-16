/**
 * The trailing "External services" lane: databases, third-party APIs, AI
 * models, and MCP servers a project's code actually calls, sourced from the
 * External Surface Inventory a prior `vg scan` recorded (`.vibgrate/scan_result.json`
 * → `extended.surfaceInventory`). Best-effort and purely additive: no scan
 * artifact, or one predating the inventory, simply means no lane — the rest
 * of the slice is unaffected.
 *
 * The inventory itself — providers, service categories, and freshness — is
 * produced by the optional `@vibgrate/relevance` module (see
 * `../surface-provider.ts`), a separate proprietary module from `@vibgrate/haile`.
 * Haile classifies internal code into roles/lanes; relevance identifies what
 * external services that code talks to. This file only joins the two: it
 * draws a line from a card to a service its own file evidence says it calls,
 * matched by file path (the inventory's evidence records `file` + a line
 * span, not a symbol id, so file-level matching is the available precision —
 * good enough to show "this project talks to Stripe", not precise enough to
 * name which one function does).
 *
 * Each service card carries the provider's category (payment, database, AI,
 * ...) as its service type, plus a two-letter monogram and the catalog's
 * canonical `providerId` — this package ships neither logo pixels nor an
 * icon library; the host UI (the VS Code webview / browser board in
 * `@vibgrate/haile`) owns resolving `providerId` to a real brand mark
 * (or not), falling back to the monogram either way.
 *
 * Most real evidence is a manifest declaration (`package.json`,
 * `pyproject.toml`, ...), not a traced import in application code — the
 * relevance module reports "this project depends on Redis," not "this
 * function calls it." A manifest file is never itself a card (only real
 * symbols become cards), so exact-file matching alone silently drops nearly
 * every service. When no card's file matches exactly, fall back to any card
 * whose file sits under the manifest's own directory — the package the
 * manifest declares dependencies for.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ExternalSurface, ScanArtifact, SurfaceCategory } from '../../core-open/index.js';
import type { ArchCard, ArchSlice, ArchSliceEdge } from './arch-types.js';

const SCAN_ARTIFACT_REL = '.vibgrate/scan_result.json';
export const EXTERNAL_LANE_ID = 'external';
const EXTERNAL_LANE_TITLE = 'External services';

/** Best-effort load of the last scan's external-surface inventory. Never throws. */
export function loadExternalSurfaces(root: string): ExternalSurface[] {
  try {
    const abs = path.join(root, SCAN_ARTIFACT_REL);
    if (!fs.existsSync(abs)) return [];
    const artifact = JSON.parse(fs.readFileSync(abs, 'utf8')) as Partial<ScanArtifact>;
    const surfaces = artifact.extended?.surfaceInventory?.surfaces;
    return Array.isArray(surfaces) ? surfaces : [];
  } catch {
    return [];
  }
}

function kindJob(kind: string): string {
  switch (kind) {
    case 'api':
      return 'External API';
    case 'model':
      return 'AI model';
    case 'mcp':
      return 'MCP server';
    case 'saas':
      return 'SaaS';
    default:
      return 'External';
  }
}

const CATEGORY_LABEL: Record<SurfaceCategory, string> = {
  ai: 'AI',
  mcp: 'MCP',
  payment: 'Payment',
  auth: 'Auth',
  email: 'Email',
  cloud: 'Cloud',
  databases: 'Database',
  messaging: 'Messaging',
  observability: 'Observability',
  crm: 'CRM',
  storage: 'Storage',
  search: 'Search',
  other: 'External',
};

const CATEGORY_COLOR: Record<SurfaceCategory, string> = {
  ai: '#8b5cf6',
  mcp: '#8b5cf6',
  payment: '#f59e0b',
  auth: '#ef4444',
  email: '#06b6d4',
  cloud: '#3b82f6',
  databases: '#10b981',
  messaging: '#ec4899',
  observability: '#14b8a6',
  crm: '#f97316',
  storage: '#0ea5e9',
  search: '#a3e635',
  other: '#64748b',
};

/** Two-letter monogram, same convention as the dashboard's Surfaces panel. */
function monogram(name: string): string {
  const words = name.split(/[\s/._-]+/).filter(Boolean);
  if (words.length >= 2) return (words[0]![0]! + words[1]![0]!).toUpperCase();
  return (words[0] ?? name).slice(0, 2).toUpperCase();
}

type VendorFamily = NonNullable<ArchCard['vendorFamily']>;

/**
 * A specific managed product's own name rarely carries a brand mark the
 * curated icon set ships (a managed Postgres, a message queue, a storage
 * bucket) — but it always belongs to a hyperscaler or platform vendor whose
 * mark it can borrow, same idea as the dashboard's `familyPrefixes`
 * (`packages/vibgrate-dash/src/lib/favicon-map.ts`). Checked in order;
 * prefix rules run before the exact-name table so a longer, more specific
 * prefix never gets shadowed. Names are matched case-insensitively.
 */
const VENDOR_FAMILY_PREFIXES: Array<[string, VendorFamily]> = [
  ['aws ', 'aws'],
  ['amazon ', 'aws'],
  ['azure ', 'azure'],
  ['google cloud ', 'gcp'],
  ['gcp ', 'gcp'],
];

/** Exact product names with no hyperscaler prefix of their own. */
const VENDOR_FAMILY_EXACT: Record<string, VendorFamily> = {
  'sql server': 'microsoft',
  'microsoft sql server': 'microsoft',
  '.net': 'microsoft',
  'dynamics 365': 'microsoft',
  'power bi': 'microsoft',
  'sharepoint': 'microsoft',
  'office 365': 'microsoft',
  'microsoft 365': 'microsoft',
  outlook: 'microsoft',
  'microsoft teams': 'microsoft',
  'active directory': 'microsoft',
  'entra id': 'azure',
  'cosmos db': 'azure',
  s3: 'aws',
  dynamodb: 'aws',
  lambda: 'aws',
  'ec2': 'aws',
  'cloudfront': 'aws',
  sqs: 'aws',
  sns: 'aws',
  'oracle database': 'oracle',
  'oracle db': 'oracle',
  salesforce: 'salesforce',
  heroku: 'salesforce',
  slack: 'slack',
  twilio: 'twilio',
  sendgrid: 'twilio',
};

/**
 * Resolve the hyperscaler/parent brand a product belongs to, for products
 * that have no brand mark of their own in the curated icon set. Returns
 * `undefined` when the name matches no known vendor family — the host UI
 * then falls back to the plain monogram, same as an unrecognized `providerId`.
 */
function vendorFamilyOf(displayName: string): VendorFamily | undefined {
  const lower = displayName.toLowerCase();
  for (const [prefix, family] of VENDOR_FAMILY_PREFIXES) {
    if (lower.startsWith(prefix)) return family;
  }
  return VENDOR_FAMILY_EXACT[lower];
}

/**
 * Append an "External services" column to `slice`, with one card per external
 * service whose evidence file matches a card already in this slice, and an
 * edge from each matching card to it. Each card carries the provider's
 * service type (its catalog category) and a monogram. Returns `slice`
 * unchanged when no service's evidence lands in this package (including when
 * `surfaces` is empty).
 */
const MANIFEST_BASENAMES = new Set([
  'package.json',
  'pyproject.toml',
  'requirements.txt',
  'go.mod',
  'cargo.toml',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'gemfile',
  'composer.json',
  'csproj',
]);

function isManifestFile(file: string): boolean {
  const base = (file.split('/').pop() ?? '').toLowerCase();
  return MANIFEST_BASENAMES.has(base) || base.endsWith('.csproj');
}

function directoryOf(file: string): string {
  const idx = file.lastIndexOf('/');
  return idx === -1 ? '' : file.slice(0, idx);
}

export function withExternalLane(slice: ArchSlice, surfaces: ExternalSurface[]): ArchSlice {
  if (!surfaces.length) return slice;

  const cardsByFile = new Map<string, ArchCard[]>();
  const allCards: ArchCard[] = [];
  for (const col of slice.columns) {
    for (const card of col.cards) {
      allCards.push(card);
      const files = new Set([card.file, ...(card.members ?? []).map((m) => m.file)].filter(Boolean));
      for (const file of files) {
        const list = cardsByFile.get(file) ?? [];
        list.push(card);
        cardsByFile.set(file, list);
      }
    }
  }
  if (cardsByFile.size === 0) return slice;

  const extCards: ArchCard[] = [];
  const extEdges: ArchSliceEdge[] = [];
  const seenEdge = new Set<string>();

  for (const surface of surfaces) {
    const callers = new Set<ArchCard>();
    for (const evidence of surface.evidence) {
      const exact = cardsByFile.get(evidence.file);
      if (exact) {
        for (const card of exact) callers.add(card);
        continue;
      }
      // Manifest-only evidence: attribute to the manifest's own directory
      // (or the whole package, for a manifest at its root) — capped to the
      // few most substantial cards there so a root manifest doesn't wire
      // every card in the package to the same service.
      if (!isManifestFile(evidence.file)) continue;
      const dir = directoryOf(evidence.file);
      const prefix = dir ? `${dir}/` : '';
      const owned = allCards
        .filter((card) => card.file.startsWith(prefix))
        .sort((a, b) => b.count - a.count)
        .slice(0, 4);
      for (const card of owned) callers.add(card);
    }
    if (callers.size === 0) continue;

    const extId = `external:${surface.id}`;
    const displayName = String(surface.displayName || surface.detectedId || surface.id).slice(0, 160);
    const category = surface.provider.category;
    const vendorFamily = vendorFamilyOf(displayName);
    extCards.push({
      id: extId,
      title: displayName,
      subtitle: `${CATEGORY_LABEL[category]} · ${kindJob(surface.kind)}`,
      lane: EXTERNAL_LANE_ID,
      file: '',
      line: null,
      symbolId: extId,
      count: callers.size,
      job: kindJob(surface.kind),
      color: CATEGORY_COLOR[category],
      classified: true,
      pulse: false,
      missingStep: false,
      ghost: true,
      logoText: monogram(displayName),
      providerId: surface.provider.id,
      ...(vendorFamily ? { vendorFamily } : {}),
    });
    for (const card of callers) {
      const id = `${card.id}|calls|${extId}`;
      if (seenEdge.has(id)) continue;
      seenEdge.add(id);
      extEdges.push({ id, src: card.id, dst: extId, kind: 'calls' });
    }
  }

  if (!extCards.length) return slice;
  extCards.sort((a, b) => a.title.localeCompare(b.title));
  return {
    ...slice,
    columns: [...slice.columns, { id: EXTERNAL_LANE_ID, title: EXTERNAL_LANE_TITLE, cards: extCards }],
    edges: [...slice.edges, ...extEdges],
  };
}
