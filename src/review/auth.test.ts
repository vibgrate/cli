import { describe, expect, it } from 'vitest';
import {
  AUTH_DOMINANCE_SHARE,
  MIN_SECURITY_PEERS,
  classifyRoute,
  looksLikeGuard,
  voteAllAuth,
  voteAuth,
  type ClassifiedRoute,
  type Route,
} from './auth.js';
import { extractRoutes, routesForFile } from './routes.js';

function route(overrides: Partial<Route> = {}): Route {
  return {
    path: '/invoices',
    file: 'src/routes/invoices.ts',
    line: 10,
    method: 'POST',
    inlineGuards: [],
    inheritedGuards: [],
    explicitlyPublic: false,
    unreadable: false,
    ...overrides,
  };
}

const classified = (overrides: Partial<Route> = {}): ClassifiedRoute => classifyRoute(route(overrides));

// ── the three-answer rule ───────────────────────────────────────────────────

describe('classifyRoute', () => {
  it('calls a route with an inline guard `auth`', () => {
    const r = classified({ inlineGuards: ['requireAuth, handler'] });
    expect(r.verdict).toBe('auth');
    expect(r.rule).toBe('inline-guard');
  });

  it('honours a guard inherited from a router-level middleware', () => {
    // The failure mode of file-wide regex matching in reverse: the guard is not
    // on the route line, it is on the router the route hangs off.
    const r = classified({ inheritedGuards: ['router.use(requireAuth)'] });
    expect(r.verdict).toBe('auth');
    expect(r.rule).toBe('inherited-guard');
  });

  it('calls a readable route with no guard anywhere in scope `not-auth`', () => {
    const r = classified();
    expect(r.verdict).toBe('not-auth');
    expect(r.rule).toBe('no-guard-in-scope');
  });

  it('never promotes an unreadable route to a verdict', () => {
    // The load-bearing safety rule: we could not parse it, so we do not know.
    const r = classified({ unreadable: true });
    expect(r.verdict).toBe('unsure');
  });

  it('degrades an unrecognised guard expression to `unsure`, never `not-auth`', () => {
    // A bespoke in-house guard we do not have vocabulary for must not be read
    // as "this route is open" — that would be a false protected finding.
    const r = classified({ inlineGuards: ['ourCustomBespokeCheck(req), handler'] });
    expect(r.verdict).toBe('unsure');
    expect(r.rule).toBe('unrecognised-guard-expression');
  });

  it('respects an explicit public marker over everything else', () => {
    const r = classified({ explicitlyPublic: true, unreadable: true });
    expect(r.verdict).toBe('not-auth');
    expect(r.rule).toBe('explicit-public-marker');
  });

  it.each([
    ['requireAuth(req)', true],
    ['[Authorize]', true],
    ['@UseGuards(AuthGuard)', true],
    ['@PreAuthorize("hasRole(\'ADMIN\')")', true],
    ['passport.authenticate("jwt")', true],
    ['@login_required', true],
    ['const canonical = 1', false],
    ['// nothing here', false],
    ['guardian.notify()', false],
  ])('recognises %j as a guard: %s', (expression, expected) => {
    expect(looksLikeGuard(expression)).toBe(expected);
  });

  it('does not mistake an unrelated word containing a guard substring', () => {
    // `canonical` contains "can"; a naive \bcan\b-style pattern fires on it.
    expect(looksLikeGuard('const canonicalUrl = buildCanonical()')).toBe(false);
  });
});

// ── the vote ────────────────────────────────────────────────────────────────

describe('voteAuth', () => {
  const guarded = (n: number, base: Partial<Route> = {}): ClassifiedRoute[] =>
    Array.from({ length: n }, (_, i) =>
      classified({ ...base, path: `/g${i}`, inlineGuards: ['requireAuth'] }),
    );
  const open = (n: number, base: Partial<Route> = {}): ClassifiedRoute[] =>
    Array.from({ length: n }, (_, i) => classified({ ...base, path: `/o${i}` }));

  it('flags an unguarded route among a dominantly guarded group', () => {
    const vote = voteAuth('src/routes', [...guarded(4), ...open(1)]);
    expect(vote.share).toBeCloseTo(0.8, 5);
    expect(vote.deviators).toHaveLength(1);
    expect(vote.aboveFloor).toBe(true);
  });

  it('stays advisory below the peer floor', () => {
    // Three routes cannot establish "guarding is the convention here".
    const vote = voteAuth('src/routes', [...guarded(2), ...open(1)]);
    expect(vote.aboveFloor).toBe(false);
    expect(MIN_SECURITY_PEERS).toBe(4);
  });

  it('does not flag anything when guarding is not the convention', () => {
    const vote = voteAuth('src/routes', [...guarded(1), ...open(4)]);
    expect(vote.share).toBeLessThan(AUTH_DOMINANCE_SHARE);
    expect(vote.deviators).toEqual([]);
  });

  it('counts only mutating methods', () => {
    // Five guarded GETs must not make one unguarded GET a deviation, and must
    // not dilute a POST convention either.
    const vote = voteAuth('src/routes', [
      ...guarded(5, { method: 'GET' }),
      ...open(1, { method: 'GET' }),
    ]);
    expect(vote.classified).toBe(0);
    expect(vote.deviators).toEqual([]);
  });

  it('excludes unsure routes from the share entirely', () => {
    // 4 guarded, 1 unsure. The unsure route must neither count as guarded
    // (inflating the share) nor as open (creating a phantom deviator).
    const vote = voteAuth('src/routes', [
      ...guarded(4),
      classified({ path: '/x', unreadable: true }),
    ]);
    expect(vote.classified).toBe(4);
    expect(vote.share).toBe(1);
    expect(vote.deviators).toEqual([]);
    expect(vote.unsure).toHaveLength(1);
  });

  it('reports an empty group without dividing by zero', () => {
    const vote = voteAuth('src/routes', []);
    expect(vote.share).toBe(0);
    expect(vote.deviators).toEqual([]);
    expect(vote.aboveFloor).toBe(false);
  });

  it('groups by declaring directory', () => {
    const votes = voteAllAuth([
      ...guarded(4, { file: 'src/api/a.ts' }),
      ...open(1, { file: 'src/api/a.ts' }),
      ...open(3, { file: 'src/public/b.ts' }),
    ]);
    expect(votes.map((v) => v.group).sort()).toEqual(['src/api', 'src/public']);
    expect(votes.find((v) => v.group === 'src/api')!.deviators).toHaveLength(1);
    // The public directory has no guarded majority, so nothing is a deviation.
    expect(votes.find((v) => v.group === 'src/public')!.deviators).toEqual([]);
  });
});

// ── extraction ──────────────────────────────────────────────────────────────

describe('extractRoutes', () => {
  it('finds an Express route and its inline guard', () => {
    const routes = extractRoutes(
      'src/routes/a.ts',
      `router.post('/invoices', requireAuth, createInvoice)\n`,
    );
    expect(routes).toHaveLength(1);
    expect(routes[0].method).toBe('POST');
    expect(routes[0].path).toBe('/invoices');
    expect(classifyRoute(routes[0]).verdict).toBe('auth');
  });

  it('carries a router-level guard down to a later route', () => {
    const routes = extractRoutes(
      'src/routes/a.ts',
      ['router.use(requireAuth)', '', "router.post('/invoices', createInvoice)"].join('\n'),
    );
    expect(routes).toHaveLength(1);
    expect(classifyRoute(routes[0]).verdict).toBe('auth');
    expect(classifyRoute(routes[0]).rule).toBe('inherited-guard');
  });

  it('does not treat `.use()` as a route', () => {
    expect(extractRoutes('src/routes/a.ts', 'router.use(cors())\n')).toEqual([]);
  });

  it('finds a NestJS decorator route with its guard', () => {
    const routes = extractRoutes(
      'src/invoices.controller.ts',
      ['@UseGuards(AuthGuard)', "@Post('/invoices')", 'createInvoice() {}'].join('\n'),
    );
    expect(routes.length).toBeGreaterThan(0);
    expect(classifyRoute(routes[0]).verdict).toBe('auth');
  });

  it('finds an ASP.NET attribute route', () => {
    const routes = extractRoutes(
      'Controllers/InvoicesController.cs',
      ['[Authorize]', '[HttpPost("invoices")]', 'public IActionResult Create() { }'].join('\n'),
    );
    expect(routes.length).toBeGreaterThan(0);
    expect(routes[0].method).toBe('POST');
    expect(classifyRoute(routes[0]).verdict).toBe('auth');
  });

  it('finds an unguarded .NET route', () => {
    const routes = extractRoutes(
      'Controllers/PublicController.cs',
      ['[HttpDelete("everything")]', 'public IActionResult Nuke() { }'].join('\n'),
    );
    expect(routes[0].method).toBe('DELETE');
    expect(classifyRoute(routes[0]).verdict).toBe('not-auth');
  });

  it('honours an AllowAnonymous opt-out', () => {
    const routes = extractRoutes(
      'Controllers/PublicController.cs',
      ['[AllowAnonymous]', '[HttpPost("signup")]', 'public IActionResult SignUp() { }'].join('\n'),
    );
    expect(classifyRoute(routes[0]).rule).toBe('explicit-public-marker');
  });

  it('ignores files in languages it does not model', () => {
    expect(extractRoutes('README.md', 'router.post("/x", h)')).toEqual([]);
  });
});

describe('routesForFile', () => {
  it('marks a route-shaped file it could not parse as unreadable', () => {
    // Advertises HTTP but in a shape we do not model. Silence here would read
    // as "this controller has no endpoints", which is worse than admitting it.
    const routes = routesForFile('src/api/handler.ts', 'export const handler = createEndpoint(...)');
    expect(routes).toHaveLength(1);
    expect(routes[0].unreadable).toBe(true);
    expect(classifyRoute(routes[0]).verdict).toBe('unsure');
  });

  it('stays silent on a file with nothing to do with routing', () => {
    expect(routesForFile('src/util/math.ts', 'export const add = (a, b) => a + b')).toEqual([]);
  });
});

// ── the false-negative that matters most ────────────────────────────────────

describe('guard scoping does not leak between adjacent routes', () => {
  /**
   * The worst thing this module can do is call an open route guarded. The
   * easiest way to cause it is to look at "a few lines around" a declaration:
   * an unguarded route sitting directly under a guarded one then inherits its
   * neighbour's guard and disappears from the report.
   */
  it('does not let a guarded route shield the unguarded one below it', () => {
    const routes = extractRoutes(
      'src/routes/a.ts',
      [
        "router.post('/safe', requireAuth, createSafe)",
        "router.post('/danger', deleteEverything)",
      ].join('\n'),
    );
    expect(routes).toHaveLength(2);
    expect(classifyRoute(routes[0]).verdict).toBe('auth');
    expect(classifyRoute(routes[1]).verdict).toBe('not-auth');
  });

  it('does not let a decorator stack leak past an intervening body', () => {
    const routes = extractRoutes(
      'src/a.controller.ts',
      [
        '@UseGuards(AuthGuard)',
        "@Post('/safe')",
        'createSafe() { return 1; }',
        '',
        "@Post('/danger')",
        'nuke() { return 2; }',
      ].join('\n'),
    );
    const byPath = Object.fromEntries(routes.map((r) => [r.path, classifyRoute(r).verdict]));
    expect(byPath['/safe']).toBe('auth');
    expect(byPath['/danger']).toBe('not-auth');
  });

  it('still honours a genuinely inherited router-level guard for both', () => {
    const routes = extractRoutes(
      'src/routes/a.ts',
      [
        'router.use(requireAuth)',
        '',
        "router.post('/one', handleOne)",
        "router.post('/two', handleTwo)",
      ].join('\n'),
    );
    expect(routes.map((r) => classifyRoute(r).verdict)).toEqual(['auth', 'auth']);
  });
});

describe('class-level guards widen, decorator guards do not', () => {
  it('applies a class-level [Authorize] to every action in the controller', () => {
    const routes = extractRoutes(
      'Controllers/InvoicesController.cs',
      [
        '[Authorize]',
        'public class InvoicesController : ControllerBase',
        '{',
        '    [HttpPost("create")]',
        '    public IActionResult Create() { }',
        '',
        '    [HttpDelete("remove")]',
        '    public IActionResult Remove() { }',
        '}',
      ].join('\n'),
    );
    expect(routes).toHaveLength(2);
    expect(routes.map((r) => classifyRoute(r).verdict)).toEqual(['auth', 'auth']);
    expect(classifyRoute(routes[1]).rule).toBe('inherited-guard');
  });

  it('applies a class-level @UseGuards to every method in a Nest controller', () => {
    const routes = extractRoutes(
      'src/invoices.controller.ts',
      [
        '@UseGuards(AuthGuard)',
        '@Controller("invoices")',
        'export class InvoicesController {',
        '  @Post("create")',
        '  create() {}',
        '',
        '  @Delete("remove")',
        '  remove() {}',
        '}',
      ].join('\n'),
    );
    expect(routes.length).toBeGreaterThanOrEqual(2);
    expect(routes.every((r) => classifyRoute(r).verdict === 'auth')).toBe(true);
  });

  it('leaves an unguarded controller unguarded', () => {
    const routes = extractRoutes(
      'Controllers/PublicController.cs',
      [
        'public class PublicController : ControllerBase',
        '{',
        '    [HttpPost("nuke")]',
        '    public IActionResult Nuke() { }',
        '}',
      ].join('\n'),
    );
    expect(classifyRoute(routes[0]).verdict).toBe('not-auth');
  });

  it('treats an Express route with only a handler as unguarded, not unsure', () => {
    const routes = extractRoutes('src/routes/a.ts', "router.delete('/x', deleteThing)\n");
    expect(classifyRoute(routes[0]).verdict).toBe('not-auth');
    expect(classifyRoute(routes[0]).rule).toBe('no-guard-in-scope');
  });
});
