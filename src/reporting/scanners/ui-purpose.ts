import type { FileCache } from '../../core-open/index.js';

const UI_EXTENSIONS = new Set([
  '.tsx', '.jsx', '.ts', '.js', '.vue', '.svelte', '.html', '.mdx', '.json', '.yml', '.yaml',
]);

const HIGH_SIGNAL_DEPENDENCIES = new Set([
  'stripe',
  'posthog-js',
  'posthog-node',
  '@sentry/node',
  '@sentry/browser',
  '@sentry/react',
  'next-auth',
  'firebase',
  'auth0',
  '@auth0/auth0-react',
  '@supabase/supabase-js',
  'supabase',
  'clerk',
  '@clerk/clerk-js',
  '@clerk/react',
]);

const GENERIC_LOW_SIGNAL = new Set(['welcome', 'home', 'click here', 'learn more', 'submit', 'cancel']);

export type UiEvidenceKind =
  | 'route'
  | 'nav'
  | 'title'
  | 'heading'
  | 'cta'
  | 'copy'
  | 'dependency'
  | 'feature_flag';

export interface UiEvidenceItem {
  kind: UiEvidenceKind;
  value: string;
  file: string;
  weight: number;
}

export interface UiPurposeResult {
  enabled: boolean;
  detectedFrameworks: string[];
  evidenceCount: number;
  capped: boolean;
  topEvidence: UiEvidenceItem[];
  unknownSignals: string[];
}

export async function scanUiPurpose(rootDir: string, fileCache: FileCache, maxItems = 300): Promise<UiPurposeResult> {
  const entries = await fileCache.walkDir(rootDir);
  const files = entries.filter((e) => e.isFile);

  // Collect all package.json files (not inside node_modules) to detect frameworks
  const packageJsonEntries = files.filter(
    (e) => e.relPath.endsWith('package.json') && !e.relPath.includes('node_modules'),
  );
  const allPkgJsons: Record<string, unknown>[] = [];
  for (const entry of packageJsonEntries) {
    try {
      allPkgJsons.push(JSON.parse(await fileCache.readTextFile(entry.absPath)) as Record<string, unknown>);
    } catch {
      // skip malformed package.json
    }
  }

  const frameworks = detectFrameworksFromAll(allPkgJsons);
  const items: UiEvidenceItem[] = [];

  for (const entry of files) {
    const ext = extension(entry.relPath);
    if (!UI_EXTENSIONS.has(ext)) continue;

    if (!isLikelyUiPath(entry.relPath)) {
      // keep route hints even for backend/router paths
      const routeHints = extractRouteHints(entry.relPath, frameworks);
      if (routeHints.length > 0) {
        items.push(...routeHints.map((r) => ({ ...r, file: entry.relPath })));
      }
      continue;
    }

    const routeHints = extractRouteHints(entry.relPath, frameworks);
    if (routeHints.length > 0) {
      items.push(...routeHints.map((r) => ({ ...r, file: entry.relPath })));
    }

    const src = await fileCache.readTextFile(entry.absPath);
    if (!src || src.length > 512_000) continue;

    const strings = extractUiStrings(src);
    for (const text of strings) {
      const kind = classifyString(text);
      const weight = scoreString(kind, text);
      items.push({ kind, value: text, file: entry.relPath, weight });
    }

    if (/(featureFlag|FEATURE_FLAG|launchDarkly|isFeatureEnabled|flags\.)/.test(src)) {
      items.push({ kind: 'feature_flag', value: `flags in ${entry.relPath}`, file: entry.relPath, weight: 2 });
    }
  }

  for (const pkg of allPkgJsons) {
    const deps = getDependencies(pkg);
    for (const [name, version] of deps) {
      if (HIGH_SIGNAL_DEPENDENCIES.has(name)) {
        items.push({ kind: 'dependency', value: `${name}@${version}`, file: 'package.json', weight: 4 });
      }
    }
  }

  const deduped = dedupeByKindValue(items).sort((a, b) => b.weight - a.weight || a.value.localeCompare(b.value));
  const cappedItems = deduped.slice(0, maxItems);

  const unknownSignals = buildUnknowns(cappedItems);

  return {
    enabled: true,
    detectedFrameworks: frameworks,
    evidenceCount: deduped.length,
    capped: deduped.length > cappedItems.length,
    topEvidence: cappedItems,
    unknownSignals,
  };
}

function extension(relPath: string): string {
  const i = relPath.lastIndexOf('.');
  return i === -1 ? '' : relPath.slice(i).toLowerCase();
}

function isLikelyUiPath(relPath: string): boolean {
  const lower = relPath.toLowerCase();
  return (
    lower.startsWith('pages/') || lower.includes('/pages/') ||
    lower.startsWith('app/') || lower.includes('/app/') ||
    lower.startsWith('components/') || lower.includes('/components/') ||
    lower.startsWith('ui/') || lower.includes('/ui/') ||
    lower.startsWith('views/') || lower.includes('/views/') ||
    lower.includes('/routes') || lower.startsWith('routes') ||
    lower.includes('/router') || lower.startsWith('router') ||
    lower.startsWith('locales/') || lower.includes('/locales/') ||
    lower.startsWith('i18n/') || lower.includes('/i18n/') ||
    lower.endsWith('.html') ||
    lower.endsWith('.mdx')
  );
}

function detectFrameworksFromAll(pkgJsons: Record<string, unknown>[]): string[] {
  const hits = new Set<string>();
  for (const pkgJson of pkgJsons) {
    const deps = {
      ...(asRecord(pkgJson.dependencies)),
      ...(asRecord(pkgJson.devDependencies)),
    };
    if (deps.next) hits.add('nextjs');
    if (deps.nuxt || deps.nuxt3) hits.add('nuxt');
    if (deps.react) hits.add('react');
    if (deps.vue) hits.add('vue');
    if (deps.svelte) hits.add('svelte');
    if (deps['@angular/core']) hits.add('angular');
  }
  return Array.from(hits);
}

function extractRouteHints(relPath: string, frameworks: string[]): Array<Omit<UiEvidenceItem, 'file'>> {
  const items: Array<Omit<UiEvidenceItem, 'file'>> = [];

  if (frameworks.includes('nextjs')) {
    const m = relPath.match(/^(?:src\/)?(pages|app)\/(.+)\.(tsx|jsx|ts|js)$/);
    if (m) {
      let route = '/' + m[2]
        .replace(/(^|\/)page$/i, '')
        .replace(/(^|\/)route$/i, '')
        .replace(/index$/i, '')
        .replace(/\[(?:\.\.\.)?(.+?)\]/g, ':$1')
        .replace(/\/+/g, '/');
      if (route !== '/' && route.endsWith('/')) route = route.slice(0, -1);
      items.push({ kind: 'route', value: route || '/', weight: 5 });
    }
  }

  if (/(^|\/)(routes?|router)\.(ts|js|json)$/.test(relPath) || relPath.includes('/router/')) {
    items.push({ kind: 'route', value: `route config: ${relPath}`, weight: 3 });
  }

  return items;
}

function extractUiStrings(src: string): string[] {
  const out: string[] = [];

  const textNodeRegex = />\s*([A-Za-z0-9][^<>]{2,120}?)\s*</g;
  for (const m of src.matchAll(textNodeRegex)) {
    const s = normaliseText(m[1] ?? '');
    if (isUsefulString(s)) out.push(s);
  }

  const titleRegex = /<title>\s*([^<]{2,120})\s*<\/title>|title\s*[:=]\s*["'`](.{2,120}?)["'`]/g;
  for (const m of src.matchAll(titleRegex)) {
    const s = normaliseText((m[1] ?? m[2] ?? '').trim());
    if (isUsefulString(s)) out.push(s);
  }

  const attrRegex = /(?:aria-label|label|placeholder|alt)\s*=\s*["'`](.{2,120}?)["'`]/g;
  for (const m of src.matchAll(attrRegex)) {
    const s = normaliseText(m[1] ?? '');
    if (isUsefulString(s)) out.push(s);
  }

  const jsonValueRegex = /:\s*["'`](.{2,140}?)["'`]\s*[,\n]/g;
  for (const m of src.matchAll(jsonValueRegex)) {
    const s = normaliseText(m[1] ?? '');
    if (isUsefulString(s)) out.push(s);
  }

  return out;
}

function classifyString(s: string): UiEvidenceKind {
  const lower = s.toLowerCase();
  if (/(pricing|plan|billing|subscription|trial|credit)/.test(lower)) return 'copy';
  if (/(sign in|sign up|log in|register|invite|workspace|organization|sso|oauth)/.test(lower)) return 'copy';
  if (/(dashboard|reports|settings|integrations|users|roles|permissions)/.test(lower)) return 'heading';
  if (/(get started|start|scan|generate|export|run|deploy|upgrade|analy[sz]e)/.test(lower)) return 'cta';
  if (/(overview|features|about|documentation|docs)/.test(lower)) return 'title';
  if (/(menu|navigation|sidebar|breadcrumb)/.test(lower)) return 'nav';
  return 'copy';
}

function scoreString(kind: UiEvidenceKind, value: string): number {
  const lower = value.toLowerCase();
  if (GENERIC_LOW_SIGNAL.has(lower)) return 0;

  let score = 1;
  if (kind === 'route') score += 4;
  if (kind === 'nav') score += 3;
  if (kind === 'title') score += 2;
  if (kind === 'heading') score += 2;
  if (kind === 'cta') score += 2;

  if (/(pricing|billing|subscription|auth|security|integration)/.test(lower)) score += 2;
  if (/(dashboard|report|scan|workspace|project|repository)/.test(lower)) score += 1;

  return score;
}

function dedupeByKindValue(items: UiEvidenceItem[]): UiEvidenceItem[] {
  const seen = new Map<string, UiEvidenceItem>();
  for (const item of items) {
    const key = `${item.kind}::${item.value.toLowerCase()}`;
    const prev = seen.get(key);
    if (!prev || item.weight > prev.weight) {
      seen.set(key, item);
    }
  }
  return Array.from(seen.values()).filter((i) => i.weight > 0);
}

function buildUnknowns(items: UiEvidenceItem[]): string[] {
  const unknowns: string[] = [];
  const hasPricing = items.some((i) => /pricing|billing|subscription|trial|credit/i.test(i.value));
  const hasAuth = items.some((i) => /sign in|sign up|login|auth|sso|oauth|invite/i.test(i.value));
  const hasIntegrations = items.some((i) => /integration|webhook|api key|connector/i.test(i.value));
  const hasRoutes = items.some((i) => i.kind === 'route');

  if (!hasPricing) unknowns.push('No pricing or billing evidence found.');
  if (!hasAuth) unknowns.push('No authentication or user access flow evidence found.');
  if (!hasIntegrations) unknowns.push('No integrations/connectors evidence found.');
  if (!hasRoutes) unknowns.push('No route structure evidence found.');

  return unknowns;
}

function asRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {};
  return value as Record<string, string>;
}

function getDependencies(pkgJson: Record<string, unknown>): Array<[string, string]> {
  return Object.entries(asRecord(pkgJson.dependencies));
}

function normaliseText(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function isUsefulString(s: string): boolean {
  if (!s || s.length < 3 || s.length > 160) return false;
  if (/^[0-9_./-]+$/.test(s)) return false;
  if (/^(true|false|null|undefined)$/i.test(s)) return false;
  if (/[<>{}]/.test(s)) return false;
  if (/function\s*\(|=>|console\.|import\s+|export\s+/.test(s)) return false;
  return true;
}
