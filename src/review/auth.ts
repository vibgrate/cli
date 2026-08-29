/**
 * Route authorization classification — the protected-finding engine.
 *
 * Replaces "does this file contain a word that looks like a guard?" with an
 * actual model of routes and the guards that reach them. The difference matters
 * because `unguarded_entrypoint` is a **protected** finding: policy cannot emit
 * `pass` while one is unresolved, so a false positive here blocks a merge and a
 * false negative ships an open endpoint. Neither is acceptable, and a regex
 * over a whole file produces both — it fires on a handler whose only "auth" is
 * the word `canonical`, and misses a route guarded by a router-level middleware
 * three lines above.
 *
 * The design rule that makes it safe: **there are three answers, not two.**
 * A route is `auth`, `not-auth`, or `unsure`, and `unsure` is never promoted to
 * either. An ambiguous route contributes nothing to the vote and produces no
 * protected finding — it becomes an honest unknown instead. Claiming a route is
 * guarded when we could not tell is the one failure mode that would make the
 * protected-finding invariant a lie.
 */

/** Below this many classified peers, a deviation is advisory and cannot gate. */
export const MIN_SECURITY_PEERS = 4;

/** Share of peers that must be guarded before an unguarded one is a deviation. */
export const AUTH_DOMINANCE_SHARE = 0.75;

/** Methods that change state. An unguarded GET is a different (lesser) problem. */
export const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE', 'ALL']);

export type AuthVerdict = 'auth' | 'not-auth' | 'unsure';

export interface Route {
  path: string;
  /** Repo-relative file the route is declared in. */
  file: string;
  line: number;
  method: string;
  /** Route-level guard expressions found on the declaration itself. */
  inlineGuards: string[];
  /** Guards inherited from a router/group/controller the route sits inside. */
  inheritedGuards: string[];
  /** True when the declaration explicitly opts out (`@public`, allowlist). */
  explicitlyPublic: boolean;
  /** True when the file could not be parsed with confidence. */
  unreadable: boolean;
}

export interface ClassifiedRoute extends Route {
  verdict: AuthVerdict;
  /** Which rule decided it — carried into the finding's evidence. */
  rule: string;
}

/**
 * Guard vocabulary. Recognition is generous and the *absence* claim is narrow:
 * an unrecognised call makes a route `unsure`, never `not-auth`, so a bespoke
 * in-house guard degrades to "we could not tell" rather than "it is open".
 */
const GUARD_CALL =
  /\b(authorize|authorise|authenticate|requireAuth|requireUser|requireLogin|requireRole|requireScope|requirePermission|ensureAuth|ensureLoggedIn|checkPermission|checkAccess|hasPermission|hasRole|verifyToken|verifyJwt|verifySession|assertScope|assertPermission|isAuthenticated|withAuth|protect|guard)\b/i;

const GUARD_ATTRIBUTE =
  /(\[\s*Authorize\b)|(@(?:PreAuthorize|PostAuthorize|Secured|RolesAllowed|UseGuards|login_required|permission_required|requires_auth|authenticated))\b/;

const GUARD_MIDDLEWARE = /\b(passport|jwt|oauth|session|clerk|auth0|nextAuth|authMiddleware|isAuth)\b/i;

/**
 * Explicit opt-outs. A route that says it is public is not a finding.
 * Exported so the extractor and the classifier cannot drift apart — two copies
 * of a safety-critical pattern is how a suppression stops working silently.
 */
export const PUBLIC_MARKER =
  /(@vibgrate-public|@public\b|\[\s*AllowAnonymous\s*\]|@AnonymousAllowed|permit_all|public\s*:\s*true)/i;

export function looksLikeGuard(expression: string): boolean {
  return (
    GUARD_CALL.test(expression) || GUARD_ATTRIBUTE.test(expression) || GUARD_MIDDLEWARE.test(expression)
  );
}

/**
 * Classify one route, by a fixed precedence. The order is the safety property:
 * an explicit public marker beats everything (a human said so), unreadability
 * beats a guess, and a guard has to be *visible* to count.
 *
 * 1. explicitly public  → `not-auth` (declared, not inferred — no finding)
 * 2. unreadable         → `unsure`   (we could not parse it; never guess)
 * 3. inline guard       → `auth`
 * 4. inherited guard    → `auth`
 * 5. otherwise          → `not-auth` for a readable route with no guard at all
 *
 * Rule 5 is the only one that can produce a protected finding, and it requires
 * the file to have parsed cleanly *and* no guard to be present anywhere in
 * scope. Everything short of that lands on `unsure`.
 */
export function classifyRoute(route: Route): ClassifiedRoute {
  const decide = (verdict: AuthVerdict, rule: string): ClassifiedRoute => ({ ...route, verdict, rule });

  if (route.explicitlyPublic) return decide('not-auth', 'explicit-public-marker');
  if (route.unreadable) return decide('unsure', 'unreadable');
  if (route.inlineGuards.some(looksLikeGuard)) return decide('auth', 'inline-guard');
  if (route.inheritedGuards.some(looksLikeGuard)) return decide('auth', 'inherited-guard');
  // A guard-shaped expression we do not recognise: present but unclassifiable.
  if (route.inlineGuards.length > 0 || route.inheritedGuards.length > 0) {
    return decide('unsure', 'unrecognised-guard-expression');
  }
  return decide('not-auth', 'no-guard-in-scope');
}

export interface AuthVote {
  /** Peer group — the directory the routes are declared in. */
  group: string;
  /** Routes that reached a verdict (`unsure` excluded). */
  classified: number;
  guarded: number;
  share: number;
  /** True once `classified >= MIN_SECURITY_PEERS`. */
  aboveFloor: boolean;
  /** Mutating routes with no guard, when the group is dominantly guarded. */
  deviators: ClassifiedRoute[];
  /** Routes we could not classify — reported as unknowns, never as safe. */
  unsure: ClassifiedRoute[];
}

/**
 * Vote a group of routes on whether guarding is the convention here.
 *
 * Only **mutating** methods vote. A codebase that guards writes and leaves
 * reads open is making a deliberate choice, and counting the GETs would dilute
 * the share until the writes stop being a convention at all.
 *
 * The peer floor is what stops this being noise on a small surface: below
 * {@link MIN_SECURITY_PEERS} classified routes, "most routes here are guarded"
 * is not a claim three files can support, so findings are reported as advisory
 * and are not allowed to gate.
 */
export function voteAuth(group: string, routes: readonly ClassifiedRoute[]): AuthVote {
  const mutating = routes.filter((r) => MUTATING_METHODS.has(r.method.toUpperCase()));
  const unsure = mutating.filter((r) => r.verdict === 'unsure');
  const decided = mutating.filter((r) => r.verdict !== 'unsure');
  const guarded = decided.filter((r) => r.verdict === 'auth');
  const share = decided.length > 0 ? guarded.length / decided.length : 0;
  const aboveFloor = decided.length >= MIN_SECURITY_PEERS;

  const dominantlyGuarded = share >= AUTH_DOMINANCE_SHARE && guarded.length > 0;
  return {
    group,
    classified: decided.length,
    guarded: guarded.length,
    share,
    aboveFloor,
    deviators: dominantlyGuarded ? decided.filter((r) => r.verdict === 'not-auth') : [],
    unsure,
  };
}

/** Group routes by the directory they are declared in, then vote each group. */
export function voteAllAuth(routes: readonly ClassifiedRoute[]): AuthVote[] {
  const groups = new Map<string, ClassifiedRoute[]>();
  for (const r of routes) {
    const dir = r.file.split('/').slice(0, -1).join('/') || '.';
    let bucket = groups.get(dir);
    if (!bucket) groups.set(dir, (bucket = []));
    bucket.push(r);
  }
  return [...groups.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([dir, rs]) => voteAuth(dir, rs));
}
