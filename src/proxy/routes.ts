/**
 * The route table (DESIGN.md §3.3). Each entry names its guard:
 *  - `open`: no token needed (probes);
 *  - `auth`: token when one is configured;
 *  - `admin`: loopback-only — anyone else gets a **404**, never a 403.
 */

export type RouteGuard = 'open' | 'auth' | 'admin';

export type RouteName =
  | 'health'
  | 'ready'
  | 'version'
  | 'dashboard'
  | 'stats'
  | 'savings'
  | 'settings_get'
  | 'settings_post'
  | 'metrics'
  | 'ccr_entry'
  | 'compress'
  | 'retrieve'
  | 'retrieve_get'
  | 'anthropic_messages'
  | 'anthropic_count_tokens'
  | 'openai_chat'
  | 'openai_responses'
  | 'passthrough'
  | 'gemini_passthrough'
  | 'shutdown'
  | 'clients'
  | 'cache_clear'
  | 'stats_reset';

export interface RouteMatch {
  name: RouteName;
  guard: RouteGuard;
  params: Record<string, string>;
  /** Upstream path override (aliases normalize to the canonical path). */
  upstreamPath?: string;
}

interface Route {
  method: string;
  pattern: RegExp;
  name: RouteName;
  guard: RouteGuard;
  upstreamPath?: string;
}

const ROUTES: Route[] = [
  { method: 'GET', pattern: /^\/(health|healthz|livez)$/, name: 'health', guard: 'open' },
  { method: 'GET', pattern: /^\/(ready|readyz)$/, name: 'ready', guard: 'open' },
  { method: 'GET', pattern: /^\/version$/, name: 'version', guard: 'open' },
  { method: 'GET', pattern: /^\/(dashboard\/?)?$/, name: 'dashboard', guard: 'auth' },
  { method: 'GET', pattern: /^\/api\/stats$/, name: 'stats', guard: 'auth' },
  { method: 'GET', pattern: /^\/api\/savings$/, name: 'savings', guard: 'auth' },
  { method: 'GET', pattern: /^\/api\/settings$/, name: 'settings_get', guard: 'admin' },
  { method: 'POST', pattern: /^\/api\/settings$/, name: 'settings_post', guard: 'admin' },
  { method: 'GET', pattern: /^\/metrics$/, name: 'metrics', guard: 'auth' },
  { method: 'GET', pattern: /^\/api\/ccr\/(?<hash>[A-Za-z0-9]+)$/, name: 'ccr_entry', guard: 'admin' },
  { method: 'POST', pattern: /^\/v1\/compress$/, name: 'compress', guard: 'auth' },
  { method: 'POST', pattern: /^\/v1\/retrieve$/, name: 'retrieve', guard: 'auth' },
  { method: 'GET', pattern: /^\/v1\/retrieve\/(?<hash>[A-Za-z0-9]+)$/, name: 'retrieve_get', guard: 'auth' },
  { method: 'POST', pattern: /^\/v1\/messages\/count_tokens$/, name: 'anthropic_count_tokens', guard: 'auth' },
  { method: 'POST', pattern: /^\/v1\/messages$/, name: 'anthropic_messages', guard: 'auth' },
  { method: 'POST', pattern: /^\/anthropic\/v1\/messages$/, name: 'anthropic_messages', guard: 'auth', upstreamPath: '/v1/messages' },
  { method: 'POST', pattern: /^\/(v1\/)?chat\/completions$/, name: 'openai_chat', guard: 'auth', upstreamPath: '/v1/chat/completions' },
  { method: 'POST', pattern: /^\/(v1\/|backend-api\/)?(codex\/)?responses$/, name: 'openai_responses', guard: 'auth', upstreamPath: '/v1/responses' },
  { method: 'POST', pattern: /^\/v1\/embeddings$/, name: 'passthrough', guard: 'auth' },
  { method: 'GET', pattern: /^\/v1\/models(\/[^/]+)?$/, name: 'passthrough', guard: 'auth' },
  { method: 'POST', pattern: /^\/v1\/(moderations|audio\/transcriptions|audio\/speech)$/, name: 'passthrough', guard: 'auth' },
  { method: 'POST', pattern: /^\/v1\/messages\/batches(\/.*)?$/, name: 'passthrough', guard: 'auth' },
  { method: 'GET', pattern: /^\/v1\/messages\/batches(\/.*)?$/, name: 'passthrough', guard: 'auth' },
  // Gemini's native API (Gemini CLI with GOOGLE_GEMINI_BASE_URL, the Google
  // GenAI SDKs): forwarded whole, query string included (`?alt=sse`, `?key=`).
  // Not compressed yet — the pipeline knows the `contents[].parts` shape, the
  // wire handler does not — but never a 404 either.
  { method: 'POST', pattern: /^\/v1(?:beta|alpha)?\/(?:models|tunedModels|cachedContents|files|batches|corpora)(\/.*)?$/, name: 'gemini_passthrough', guard: 'auth' },
  { method: 'GET', pattern: /^\/v1(?:beta|alpha)?\/(?:models|tunedModels|cachedContents|files|batches|corpora)(\/.*)?$/, name: 'gemini_passthrough', guard: 'auth' },
  { method: 'DELETE', pattern: /^\/v1(?:beta|alpha)?\/(?:cachedContents|files)\/.+$/, name: 'gemini_passthrough', guard: 'auth' },
  { method: 'POST', pattern: /^\/api\/proxy\/shutdown$/, name: 'shutdown', guard: 'admin' },
  { method: 'GET', pattern: /^\/api\/proxy\/clients$/, name: 'clients', guard: 'auth' },
  { method: 'POST', pattern: /^\/api\/cache\/clear$/, name: 'cache_clear', guard: 'admin' },
  { method: 'POST', pattern: /^\/api\/stats\/reset$/, name: 'stats_reset', guard: 'admin' },
];

export function matchRoute(method: string, pathname: string): RouteMatch | null {
  const m = method.toUpperCase();
  for (const r of ROUTES) {
    if (r.method !== m && !(r.method === 'GET' && m === 'HEAD')) continue;
    const hit = r.pattern.exec(pathname);
    if (!hit) continue;
    return { name: r.name, guard: r.guard, params: { ...(hit.groups ?? {}) }, upstreamPath: r.upstreamPath };
  }
  return null;
}

/** Whether any route exists for the path (used to answer 405 vs 404). */
export function pathKnown(pathname: string): boolean {
  return ROUTES.some((r) => r.pattern.test(pathname));
}

export const ROUTE_TABLE: ReadonlyArray<{ method: string; pattern: string; name: RouteName; guard: RouteGuard }> = ROUTES.map((r) => ({ method: r.method, pattern: r.pattern.source, name: r.name, guard: r.guard }));
