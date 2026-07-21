import { SHARED_LITERALS } from './xl-fixture.mjs';

/**
 * The locate corpus: 100+ categorized search_symbols queries derived from an
 * xl-fixture catalog, each with a machine-checkable expectation. This is the
 * release-tracked measure of "no grep needed": every resolution path — exact
 * names of every symbol kind and language, case variants, qualified names,
 * file:line, globs, substrings, humanized/reconstructed identifiers, token
 * unions, quoted literals, fluent-call text, route strings, dotted config keys,
 * shared phrases with exact totals, unicode/special chars, file paths,
 * duplicates — plus must-miss probes that assert clean no-match instead of
 * confident false positives (the failure mode field testing caught).
 *
 * Entry shape:
 *   { q, category, k,                 — query, category id, top-k window
 *     expectFile?,                    — this file must appear within top-k
 *     expectFiles?,                   — ALL of these files within top-k
 *     expectLine?,                    — a match on expectFile at exactly this line
 *     expectTotal?,                   — totalTextMatches must equal this
 *     mustMiss?                       — matches must be EMPTY (hint pivot)
 *   }
 */
export function buildCorpus(catalog) {
  const c = [];
  const add = (category, q, expect = {}) => c.push({ category, q, k: expect.k ?? 5, ...expect });

  // Numeric tag as it appears in generated names (zero-padded — see fixture).
  const tagOf = (name) => name.replace(/^\D+/, '');

  catalog.services.forEach((s) => {
    add('exact-class-ts', s.cls.name, { expectFile: s.file, k: 1 });
    add('exact-interface-ts', s.iface.name, { expectFile: s.file, k: 1 });
    add('exact-method-ts', s.method.name, { expectFile: s.file, k: 1 });
    add('exact-function-ts', s.fn.name, { expectFile: s.file, k: 1 });
    add('exact-constant-ts', s.constant.name, { expectFile: s.file });
    add('case-insensitive', s.cls.name.toLowerCase(), { expectFile: s.file, k: 1 });
    add('qualified-name', `${s.cls.name}.${s.method.name}`, { expectFile: s.file, k: 1 });
    add('file-line', `${s.file}:${s.cls.line}`, { expectFile: s.file, k: 1 });
    add('reconstructed-camel', `order service ${tagOf(s.cls.name)}`, { expectFile: s.file, k: 1 });
    add('substring', s.cls.name.slice(1), { expectFile: s.file });
    add('file-path', s.file, { expectFile: s.file });
  });

  catalog.components.forEach((comp) => {
    add('exact-component-tsx', comp.comp.name, { expectFile: comp.file, k: 1 });
    add('reconstructed-camel', `user card ${tagOf(comp.comp.name)}`, { expectFile: comp.file, k: 1 });
    add('multi-token-union', `${comp.comp.name} card panel`, { expectFile: comp.file });
  });

  catalog.controllers.forEach((ctl) => {
    add('exact-class-cs', ctl.cls.name, { expectFile: ctl.file, k: 1 });
    add('exact-method-cs', ctl.method.name, { expectFile: ctl.file, k: 1 });
    add('case-insensitive', ctl.method.name.toLowerCase(), { expectFile: ctl.file, k: 1 });
    add('qualified-name', `${ctl.cls.name}.${ctl.method.name}`, { expectFile: ctl.file, k: 1 });
    add('route-literal', ctl.route.text, { expectFile: ctl.file, expectLine: ctl.route.line, expectTotal: 1 });
    add('reconstructed-camel', `get timezone id ${tagOf(ctl.method.name)}`, { expectFile: ctl.file, k: 1 });
  });

  catalog.composes.forEach((cd) => {
    add('exact-class-cs', cd.cls.name, { expectFile: cd.file, k: 1 });
    // The AddJwtBearer shape: a fluent extension-method CALL with no local
    // definition — the graph cannot resolve it, so the literal fallthrough must.
    add('fluent-call-bare', cd.call.name, { expectFile: cd.file, expectLine: cd.call.line });
    add('fluent-call-paren', cd.call.text, { expectFile: cd.file, expectLine: cd.call.line });
    add('quoted-single-name', `"${cd.call.name}"`, { expectFile: cd.file, expectLine: cd.call.line, expectTotal: 1 });
  });

  catalog.enums.forEach((e) => {
    add('duplicate-symbol', e.name, { expectFiles: e.files });
  });

  catalog.interfaces.forEach((it) => {
    add('exact-interface-cs', it.iface.name, { expectFile: it.file, k: 1 });
  });

  catalog.python.forEach((p) => {
    add('exact-class-py', p.cls.name, { expectFile: p.file, k: 1 });
    add('exact-method-py', p.method.name, { expectFile: p.file, k: 1 });
    add('exact-function-py', p.fn.name, { expectFile: p.file, k: 1 });
    add('exact-constant-py', p.constant.name, { expectFile: p.file });
    add('reconstructed-snake', `fetch rows ${tagOf(p.fn.name)}`, { expectFile: p.file, k: 1 });
    // `worker${i}` pins the union to ONE worker (a bare number token is dropped
    // as sub-2-chars, and coverage-of-one is now filtered as noise).
    add('multi-token-union', `queue worker${tagOf(p.cls.name)} batches`, { expectFile: p.file });
  });

  catalog.configs.forEach((cfg) => {
    add('config-key', cfg.key.text, { expectFile: cfg.file, expectLine: cfg.key.line });
  });

  catalog.docs.forEach((d) => {
    add('doc-phrase', d.phrase.text, { expectFile: d.file, expectLine: d.phrase.line });
  });

  // Globs — at least one family member must surface.
  add('glob', 'OrderService*', { expectFile: catalog.services[0].file });
  add('glob', `*Controller${tagOf(catalog.controllers[0].cls.name)}`, { expectFile: catalog.controllers[0].file });
  add('glob', 'fetch_rows_*', { expectFile: catalog.python[0].file });
  add('glob', 'Privilege0*', { expectFile: catalog.enums[0].files[0] });

  // Shared literals with exact repo-wide totals.
  add('shared-ui-copy', SHARED_LITERALS.uiCopy, { expectFile: catalog.components[0].file, expectTotal: catalog.components.length });
  add('shared-log-line', SHARED_LITERALS.logLine, { expectFile: catalog.services[0].file, expectTotal: catalog.services.length });
  add('shared-unicode', SHARED_LITERALS.unicode, { expectFile: catalog.docs[0].file, expectTotal: catalog.docs.length });
  add('shared-special-chars', SHARED_LITERALS.special, { expectFile: catalog.configs[0].file, expectTotal: catalog.configs.length });

  // Cross-language duplicate hub.
  add('duplicate-symbol', catalog.hub.name, { expectFiles: catalog.hub.files });

  // Must-miss probes: the honest answer is "no match", never a confident
  // false positive (the opportunities/mine failure) and never a quote-literal
  // artifact.
  add('must-miss', 'ZorblatFrobnicator', { mustMiss: true });
  add('must-miss', 'OrdreService0', { mustMiss: true }); // misspelling — no fuzzy false positive
  add('must-miss', 'opportunities/mine', { mustMiss: true }); // the field-report route
  add('must-miss', 'this phrase exists nowhere at all', { mustMiss: true });
  add('must-miss', '"NoSuchLiteralAnywhere"', { mustMiss: true });
  add('must-miss', 'Zorblat*', { mustMiss: true });

  return c;
}

/**
 * Evaluate one search_symbols result against its corpus entry.
 * Returns { pass, reason } — reason set on failure for actionable reporting.
 */
export function evaluateEntry(entry, result) {
  const top = result.matches.slice(0, entry.k ?? 5);
  const files = top.map((m) => m.file);
  if (entry.mustMiss) {
    return result.matches.length === 0
      ? { pass: true }
      : { pass: false, reason: `expected no match, got ${result.matches.length} (top: ${files[0]})` };
  }
  if (entry.expectTotal !== undefined && result.totalTextMatches !== entry.expectTotal) {
    return { pass: false, reason: `totalTextMatches ${result.totalTextMatches} ≠ ${entry.expectTotal}` };
  }
  if (entry.expectFiles) {
    const missing = entry.expectFiles.filter((f) => !files.includes(f));
    if (missing.length) return { pass: false, reason: `missing ${missing.join(', ')} in top-${entry.k}` };
    return { pass: true };
  }
  if (entry.expectFile) {
    if (!files.includes(entry.expectFile)) {
      return { pass: false, reason: `expected ${entry.expectFile} in top-${entry.k}, got [${files.join(', ')}]` };
    }
    if (entry.expectLine !== undefined && !top.some((m) => m.file === entry.expectFile && m.line === entry.expectLine)) {
      return { pass: false, reason: `no match on ${entry.expectFile}:${entry.expectLine}` };
    }
  }
  return { pass: true };
}

/** Group corpus entries and per-entry outcomes into a per-category scoreboard. */
export function scoreByCategory(outcomes) {
  const byCat = new Map();
  for (const o of outcomes) {
    const row = byCat.get(o.entry.category) ?? { category: o.entry.category, total: 0, passed: 0, ms: [], failures: [] };
    row.total++;
    if (o.pass) row.passed++;
    else row.failures.push({ q: o.entry.q, reason: o.reason });
    row.ms.push(o.ms);
    byCat.set(o.entry.category, row);
  }
  return [...byCat.values()]
    .map((r) => ({
      ...r,
      rate: r.passed / r.total,
      meanMs: r.ms.reduce((a, b) => a + b, 0) / r.ms.length,
      p95Ms: [...r.ms].sort((a, b) => a - b)[Math.min(r.ms.length - 1, Math.floor(r.ms.length * 0.95))],
    }))
    .sort((a, b) => a.category.localeCompare(b.category));
}
