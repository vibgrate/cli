/**
 * Route extraction — finding the entrypoints a change exposes.
 *
 * Deliberately a *line-oriented* extractor over the changed files rather than a
 * second AST pass: `vg build` already paid for the parse, and a full
 * framework-aware route model per language is a much larger project than the
 * protected-finding rule needs. What it must get right is narrower:
 *
 *  - find the route declarations,
 *  - find the guards that reach them, **including ones declared above** the
 *    route (router-level middleware, a class attribute, a decorator stack),
 *  - and say "I could not tell" whenever it is not sure.
 *
 * That last part is why this is safe to hang a protected finding on. The
 * extractor's failure mode is `unreadable: true` → `unsure` → no finding, never
 * a confident "unguarded".
 */

import { PUBLIC_MARKER, looksLikeGuard, type Route } from './auth.js';

/**
 * Express / Koa / Fastify / Hono: `router.post('/x', guard, handler)`.
 * The captured tail is everything between the path and the closing paren, which
 * is where inline middleware lives.
 */
const JS_ROUTE =
  /\b(?:app|router|api|server|r)\s*\.\s*(get|post|put|patch|delete|all|use)\s*\(\s*(['"`])([^'"`]*)\2\s*(,[^)]*)?/i;

/** NestJS / Spring / FastAPI / Flask decorators: `@Post('/x')`, `@app.post("/x")`. */
const DECORATOR_ROUTE =
  /@(?:app\.|router\.)?(Get|Post|Put|Patch|Delete|RequestMapping|GetMapping|PostMapping|PutMapping|DeleteMapping|route)\s*\(\s*(['"`])?([^'"`)]*)\2?/i;

/** ASP.NET attributes: `[HttpPost("x")]`. */
const DOTNET_ROUTE = /\[\s*Http(Get|Post|Put|Patch|Delete)\s*(?:\(\s*"([^"]*)"\s*\))?\s*\]/i;

/** Go: `mux.HandleFunc("/x", h)` / `r.POST("/x", h)`. */
const GO_ROUTE =
  /\b\w+\s*\.\s*(?:(GET|POST|PUT|PATCH|DELETE)|Handle(?:Func)?)\s*\(\s*"([^"]*)"\s*(,[^)]*)?/;

/**
 * Router-level middleware registration — a guard that genuinely applies to
 * every route declared after it.
 *
 * Decorator and attribute forms are deliberately **absent** here. `@UseGuards`
 * and `[Authorize]` attach to the one declaration below them; treating them as
 * scope-wide lets a guarded route shield every unguarded route after it in the
 * same file, which is the worst error this module can make. They are picked up
 * as *attached* guards instead, and only the class-level case below widens.
 */
const SCOPE_GUARD =
  /\b(?:use|Use|UseMiddleware|beforeEach|before_request|AddAuthorization|RequireAuthorization)\s*\(/;

/** A guard attribute/decorator sitting directly above a class declaration. */
const CLASS_DECLARATION = /\b(?:public\s+|export\s+|abstract\s+)*class\s+\w/;

/** How many lines above a route can still contribute an inherited guard. */
const INHERIT_WINDOW = 12;

/** Extensions this extractor understands. Anything else yields no routes. */
const SUPPORTED = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|cs|py|go|java|kt|rb|php)$/i;

function methodOf(raw: string): string {
  const m = raw.toUpperCase().replace(/MAPPING$/, '').replace(/^REQUEST$/, 'ALL');
  return m === 'ROUTE' || m === 'HANDLE' || m === 'HANDLEFUNC' ? 'ALL' : m;
}

/**
 * Extract routes from one file's text.
 *
 * `unreadable` is set when the file looks like it declares routes but in a
 * shape this extractor does not model — a framework it does not know, or a
 * generated/minified file. Those routes become `unsure` and never produce a
 * protected finding.
 */
export function extractRoutes(file: string, text: string): Route[] {
  if (!SUPPORTED.test(file)) return [];
  const lines = text.split('\n');
  const routes: Route[] = [];

  // A guard attribute above a *class* declaration really does cover every
  // action in that class, so it is the one decorator form that widens scope.
  const classGuards: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!CLASS_DECLARATION.test(lines[i])) continue;
    for (let j = i - 1; j >= 0; j--) {
      const above = lines[j].trim();
      if (!above.startsWith('@') && !above.startsWith('[')) break;
      if (looksLikeGuard(above)) classGuards.push(above);
    }
  }

  // Guards that apply to everything below them, with the line they came from.
  const scopeGuards: { line: number; text: string }[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (SCOPE_GUARD.test(line)) scopeGuards.push({ line: i, text: line.trim() });

    const js = JS_ROUTE.exec(line);
    const decorator = js ? null : DECORATOR_ROUTE.exec(line);
    const dotnet = js || decorator ? null : DOTNET_ROUTE.exec(line);
    const go = js || decorator || dotnet ? null : GO_ROUTE.exec(line);
    if (!js && !decorator && !dotnet && !go) continue;

    let method: string;
    let routePath: string;
    let inlineTail = '';
    if (js) {
      // `.use(...)` registers middleware, not a route.
      if (js[1].toLowerCase() === 'use') continue;
      method = methodOf(js[1]);
      routePath = js[3] ?? '';
      inlineTail = js[4] ?? '';
    } else if (decorator) {
      method = methodOf(decorator[1]);
      routePath = decorator[3] ?? '';
      // The declaration line is the *route*, not a guard candidate. Treating it
      // as one makes every decorator route carry a non-empty, unrecognised
      // "guard expression", so a plainly unguarded `[HttpDelete]` degrades to
      // `unsure` and can never produce the finding it should. It counts only if
      // it independently carries a guard (`@Post('/x') @UseGuards(...)`).
      inlineTail = looksLikeGuard(line) ? line : '';
    } else if (dotnet) {
      method = methodOf(dotnet[1]);
      routePath = dotnet[2] ?? '';
      inlineTail = looksLikeGuard(line) ? line : '';
    } else {
      method = methodOf(go![1] ?? 'ALL');
      routePath = go![2] ?? '';
      inlineTail = go![3] ?? '';
    }

    // The decorator/attribute stack *directly attached* to this declaration:
    // the contiguous run of `@…` / `[…]` lines immediately above it.
    //
    // This must not be a fixed window of surrounding lines. A window swallows
    // the previous route's guard, so an unguarded route declared right below a
    // guarded one reads as guarded — a false negative on a protected finding,
    // which is the single worst outcome this module can produce. It also
    // swallows router-level `use()` calls, collapsing the inline/inherited
    // distinction that makes the classifier's precedence meaningful.
    const attached: string[] = [];
    for (let j = i - 1; j >= 0; j--) {
      const above = lines[j].trim();
      if (above.startsWith('@') || above.startsWith('[')) attached.unshift(above);
      else break;
    }

    // For a call-style route the tail is `, middleware…, handler`. The final
    // argument is the handler and is never a guard, so counting it would leave
    // every route carrying a non-empty unrecognised "guard expression" — and a
    // plainly unguarded route would degrade to `unsure` instead of being found.
    const tailArgs = inlineTail
      .replace(/^\s*,/, '')
      .split(',')
      .map((a) => a.trim())
      .filter((a) => a.length > 0);
    const middlewareArgs = tailArgs.slice(0, -1);

    const inline = [...middlewareArgs, ...attached].filter((t) => t.trim().length > 0);
    routes.push({
      path: routePath,
      file,
      line: i + 1,
      method,
      inlineGuards: inline,
      inheritedGuards: [
        ...classGuards,
        ...scopeGuards.filter((g) => i - g.line <= INHERIT_WINDOW || g.line < 20).map((g) => g.text),
      ],
      explicitlyPublic: [line, ...attached].some((t) => PUBLIC_MARKER.test(t)),
      unreadable: false,
    });
  }

  return routes;
}

/**
 * Does this file look like it serves HTTP at all? Used to decide whether the
 * *absence* of extracted routes is meaningful (a plain util file) or suspicious
 * (a controller written in a framework we do not model).
 */
export function looksLikeRouteFile(text: string): boolean {
  return /\b(app|router|route|controller|handler|endpoint|@Get|@Post|HttpGet|HttpPost|HandleFunc)\b/i.test(
    text,
  );
}

/**
 * Routes for a file, marking them unreadable when the file advertises HTTP but
 * nothing could be extracted — that is the case where silence would be a lie.
 */
export function routesForFile(file: string, text: string): Route[] {
  const routes = extractRoutes(file, text);
  if (routes.length > 0) return routes;
  if (!SUPPORTED.test(file) || !looksLikeRouteFile(text)) return [];
  // It talks about routing but we could not parse a single declaration. Emit one
  // `unreadable` placeholder so the file is counted as "not classified" rather
  // than silently treated as having no entrypoints.
  return [
    {
      path: '',
      file,
      line: 1,
      method: 'ALL',
      inlineGuards: [],
      inheritedGuards: [],
      explicitlyPublic: false,
      unreadable: true,
    },
  ];
}
