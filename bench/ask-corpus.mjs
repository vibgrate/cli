/**
 * The ask/capsule relevance corpus: categorized natural-language questions
 * generated from an intent-fixture catalog, each with a machine-checkable
 * relevance expectation over the SEED list (`queryGraph` matches — the same
 * seeds `buildCodeContext` / Task Capsule expand into primary symbols).
 *
 * The corpus is generated from the catalog's DOMAIN_PACKS, so its breadth
 * follows the app-category landscape (bench/app-landscape.mjs): payments,
 * auth, e-commerce, chat, media, analytics, CMS, CI/CD, mobile, batch ETL,
 * geo, i18n, observability, feature flags, … Adding a domain pack to the
 * fixture automatically adds its name-bearing questions here; intent
 * questions come from the pack's `intents` list.
 *
 * Categories:
 *  - name-usage / name-callers / name-impact — asks naming a real symbol must
 *    pin its file (scales with the fixture: hundreds of entries)
 *  - intent-<domain> — no-shared-identifier intent asks must seed the owning
 *    domain, not surface-form traps
 *  - intent-direct-debit — one term→domain relationship instance (direct
 *    debit → payments, like locales → i18n or tailwind → css), held to the
 *    strictest expectations
 *  - trap-weak-verbs — add/create/new/via-dense asks that DO name a topic
 *  - weak-only-must-miss / off-topic-must-miss — honest empties
 *
 * Entry shape:
 *   { q, category, k,            — question, category id, top-k seed window (default 8)
 *     expectFile?,               — this file must appear within top-k
 *     expectAnyFiles?,           — at least ONE of these within top-k
 *     domainDirs?, minShare?,    — ≥ minShare of top-k seeds live under these dirs
 *     firstSeedDomain?,          — seed #1 must live under domainDirs
 *     forbidFiles?, maxForbidden? — ≤ maxForbidden top-k seeds from these files (default 0)
 *     mustMiss?                  — seed list must be EMPTY
 *   }
 */
export function buildAskCorpus(catalog) {
  const c = [];
  const add = (category, q, expect = {}) => c.push({ category, q, k: expect.k ?? 8, ...expect });

  const domains = Object.values(catalog.domains);
  const distractorFiles = catalog.distractors.files;

  /** Intent-question defaults for a domain: seed the owning dirs, keep traps out. */
  const intent = (dom, extra = {}) => ({
    expectAnyFiles: dom.files,
    domainDirs: dom.dirs,
    minShare: 0.5,
    firstSeedDomain: true,
    forbidFiles: distractorFiles,
    maxForbidden: 1,
    ...extra,
  });

  /** One representative method per file (the first declared) for callers asks. */
  const firstMethodPerFile = (dom) => {
    const seen = new Set();
    return dom.methods.filter((m) => (seen.has(m.file) ? false : (seen.add(m.file), true)));
  };

  for (const dom of domains) {
    // ---- Name-bearing asks (scale with the fixture): must pin the named file ----
    for (const cls of dom.classes) {
      add('name-usage', `explain where ${cls.name} is used`, { expectFile: cls.file, k: 3 });
    }
    for (const m of firstMethodPerFile(dom)) {
      add('name-callers', `who calls ${m.name}?`, { expectFile: m.file, k: 3 });
    }
    if (['payments', 'auth', 'ci'].includes(dom.key)) {
      for (const cls of dom.classes) {
        add('name-impact', `what breaks if I change ${cls.name}?`, { expectFile: cls.file, k: 3 });
      }
    }

    // ---- Intent asks from the pack spec (no shared identifier required) ----
    for (const q of dom.intents ?? []) {
      add(`intent-${dom.key}`, q, intent(dom));
    }
  }

  // ---- Term→domain relationship, phrased many ways: direct debit → payments.
  // One instance of the general class (a term must reach the domain that owns
  // it — locales → i18n, tailwind → css, …); it keeps its own category only
  // because it came from a field report with known-bad phrasings. Every
  // relationship instance is held to the same expectations. ----
  const payments = catalog.domains.payments;
  const ddFiles = payments.files.filter((f) => f.includes('DirectDebitMandate'));
  for (const q of [
    'what do i need to do to add payments via direct debit?',
    'add support for direct debit payments',
    'how do we take payments by direct debit?',
    'implement direct debit as a payment method',
    'set up sepa mandates so customers can pay by bank debit',
    'collect recurring payments through bacs direct debit',
  ]) {
    add('intent-direct-debit', q, intent(payments, { expectAnyFiles: ddFiles, minShare: 0.6, maxForbidden: 0 }));
  }

  // ---- Weak-verb traps: add/create/new/via-dense questions that DO name a
  // topic. The generic add*/Add*Form/submitAdd*/…Via… families must not seed. ----
  for (const [q, key] of [
    ['add a new payment method', 'payments'],
    ['create a new invoice for a customer', 'payments'],
    ['what needs to change to support direct debit?', 'payments'],
    ['add a new way to charge cards via the gateway', 'payments'],
    ['create a new session when a user logs in', 'auth'],
    ['add a new check for vulnerable packages', 'deps'],
    ['add a new step to the deploy pipeline', 'ci'],
    ['create a new experiment with a rollout flag', 'flags'],
  ]) {
    add('trap-weak-verbs', q, intent(catalog.domains[key], { maxForbidden: 0 }));
  }

  // ---- Honest misses ----
  // Weak-verb-only asks (no topic at all): an empty seed list beats a grab-bag
  // of every `add*` symbol in the repo — the exact field-report failure mode.
  add('weak-only-must-miss', 'add a new feature', { mustMiss: true });
  add('weak-only-must-miss', 'can you make changes', { mustMiss: true });
  add('weak-only-must-miss', 'do the work', { mustMiss: true });
  // Off-topic asks: nothing in the repo owns this concept.
  add('off-topic-must-miss', 'where do we tessellate quaternion frustum meshes?', { mustMiss: true });
  add('off-topic-must-miss', 'adjust the webgl shader uniforms for bloom', { mustMiss: true });

  return c;
}

/**
 * Relationship-coverage corpus: term→domain questions generated from
 * bench/relationship-pairs.json (public vendor/term relationships derived
 * from public content — gocardless→payments, i18next→i18n, …). These asks
 * name ONLY the term, never the domain, so the deterministic lexicon alone
 * cannot resolve them: they are `kernelOnly` and are scored when a relevance
 * provider is active (the CI gate's provider mode, the release benchmark's
 * kernel arm). Baseline mode reporting them as misses is the measurement,
 * not a failure. Pairs whose expansion vocabulary doesn't intersect the
 * fixture domain's files are skipped — every emitted question is winnable
 * by expansion, so a provider-mode miss is always a real ranking defect.
 */
export function buildRelationshipCorpus(catalog, pairsData) {
  const c = [];
  for (const pair of pairsData.pairs ?? []) {
    const dom = catalog.domains[pair.domain];
    if (!dom) continue;
    // Winnable = at least TWO expansion words land in the domain's own
    // files/symbols; the coverage bonus then makes converging in-domain
    // evidence dominate any single stray hit elsewhere. Question phrasings
    // deliberately carry no content words of their own — the vendor term is
    // the only bridge, which is exactly what these entries measure.
    const haystack = [...dom.files, ...dom.symbols.map((s) => s.name)].join(' ').toLowerCase();
    const hits = pair.expansions.filter((w) => haystack.includes(w.toLowerCase()));
    if (hits.length < 2) continue;
    // A pair whose expansion vocabulary also lands in the surface-form trap
    // family isn't a clean measurement of term→domain bridging — the ask
    // would partly test trap resistance instead. Skip it ("format" from
    // formatjs hits the Formatting* distractors, for example).
    const trapHaystack = [
      ...catalog.distractors.files,
      ...catalog.distractors.symbols.map((s) => s.name),
    ].join(' ').toLowerCase();
    if (pair.expansions.some((w) => trapHaystack.includes(w.toLowerCase()))) continue;
    for (const q of [`integrate ${pair.term}`, `wire ${pair.term} in`, `adopt ${pair.term} here`]) {
      c.push({
        category: `intent-rel-${pair.domain}`,
        q,
        k: 8,
        kernelOnly: true,
        domainDirs: dom.dirs,
        minShare: 0.5,
        forbidFiles: catalog.distractors.files,
        maxForbidden: 1,
      });
    }
  }
  return c;
}

/**
 * Evaluate one seed list against its corpus entry.
 * `seeds` is an ordered array of `{ file }` (extra fields ignored).
 * Returns { pass, reason } — reason set on failure for actionable reporting.
 */
export function evaluateAskEntry(entry, seeds) {
  const norm = (f) => f.replace(/\\/g, '/').replace(/^\.\//, '');
  const top = seeds.slice(0, entry.k ?? 8);
  const files = top.map((s) => norm(s.file));

  if (entry.mustMiss) {
    return seeds.length === 0
      ? { pass: true }
      : { pass: false, reason: `expected no seeds, got ${seeds.length} (top: ${files[0]})` };
  }
  if (seeds.length === 0) return { pass: false, reason: 'no seeds returned' };

  const inDomain = (f) => (entry.domainDirs ?? []).some((dir) => f.startsWith(dir));

  if (entry.expectFile && !files.includes(norm(entry.expectFile))) {
    return { pass: false, reason: `expected ${entry.expectFile} in top-${entry.k}, got [${files.join(', ')}]` };
  }
  if (entry.expectAnyFiles) {
    const want = entry.expectAnyFiles.map(norm);
    if (!files.some((f) => want.includes(f))) {
      return { pass: false, reason: `none of the expected files in top-${entry.k}, got [${files.join(', ')}]` };
    }
  }
  if (entry.firstSeedDomain && !inDomain(files[0])) {
    return { pass: false, reason: `first seed ${files[0]} is outside the domain dirs` };
  }
  if (entry.minShare !== undefined) {
    const share = files.filter(inDomain).length / files.length;
    if (share < entry.minShare) {
      return {
        pass: false,
        reason: `domain share ${share.toFixed(2)} < ${entry.minShare} (top-${entry.k}: [${files.join(', ')}])`,
      };
    }
  }
  if (entry.forbidFiles) {
    const forbidden = new Set(entry.forbidFiles.map(norm));
    const hits = files.filter((f) => forbidden.has(f));
    const allowed = entry.maxForbidden ?? 0;
    if (hits.length > allowed) {
      return { pass: false, reason: `${hits.length} distractor seeds (allowed ${allowed}): [${hits.join(', ')}]` };
    }
  }
  return { pass: true };
}
