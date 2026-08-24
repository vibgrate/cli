/**
 * The `vg code` coding-prompt relevance corpus: categorized CODING TASK
 * prompts (bug reports, feature work, test-writing, refactors, error
 * messages, stack traces, typos, colloquial phrasings) generated from an
 * intent-fixture catalog, each with a machine-checkable expectation over the
 * SEED list — the same `queryGraph` seeds `buildCodeContext` / Task Capsule
 * expand into primary symbols for `vg code`.
 *
 * The ask corpus (bench/ask-corpus.mjs) measures QUESTION-style relevance
 * ("where do we …?", "how does … work?"). This corpus measures the prompts a
 * developer actually types at a coding agent: imperative, symptom-first,
 * framed with bug-report scaffolding ("fix", "broken", "fails"), sometimes
 * carrying an exact file path, a pasted error string, or a misspelling.
 * Those surface forms stress different failure modes:
 *
 *  - bug-report framing words ("issue", "fails", "broken") acting as content
 *    evidence and dragging in `issueInvoice` / `retryFailed*` lookalikes;
 *  - pasted file paths that should PIN the named file;
 *  - quoted error messages whose words are the only topical evidence;
 *  - misspellings ("strpe", "chekout") that defeat exact matching;
 *  - imperative feature asks that are one weak verb away from the `add*`
 *    grab-bag failure.
 *
 * Entry shape and evaluation contract are shared with bench/ask-corpus.mjs
 * (`evaluateAskEntry`): { q, category, k, expectFile?, expectAnyFiles?,
 * domainDirs?, minShare?, firstSeedDomain?, forbidFiles?, maxForbidden?,
 * mustMiss? }.
 */

/** Files of a domain whose path contains `base` (fixture naming is prefix-free). */
function filesOf(dom, base) {
  return dom.files.filter((f) => f.includes(base));
}

/** Deterministic pick of one representative file per base name (spread over scale). */
function pickFile(dom, base, i = 0) {
  const files = filesOf(dom, base);
  return files[i % files.length];
}

export function buildCodeCorpus(catalog) {
  const c = [];
  const add = (category, q, expect = {}) => c.push({ category, q, k: expect.k ?? 8, ...expect });
  const distractorFiles = catalog.distractors.files;
  const d = catalog.domains;

  /** Domain-seeding defaults for symptom/feature prompts (same bar as intent asks). */
  const domain = (dom, extra = {}) => ({
    expectAnyFiles: dom.files,
    domainDirs: dom.dirs,
    minShare: 0.5,
    firstSeedDomain: true,
    forbidFiles: distractorFiles,
    maxForbidden: 1,
    ...extra,
  });

  // ------------------------------------------------------------------
  // 1. code-fix-<domain> — symptom-style bug reports. No class names; the
  //    prompt describes broken BEHAVIOUR in the domain's vocabulary plus
  //    bug-report scaffolding. Seeds must stay in the owning domain, and the
  //    named sub-feature's file must appear when one is named.
  // ------------------------------------------------------------------
  /** [prompt, domainKey, expectBase?] — expectBase narrows expectAnyFiles to one file family. */
  const FIXES = [
    ['fix the double charge when a stripe webhook is retried', 'payments', 'StripeWebhookHandler'],
    ['customers get two receipts after paying once — track it down and fix it', 'payments', 'InvoiceService'],
    ['the sepa mandate is not verified before we collect a bacs payment — fix that', 'payments', 'DirectDebitMandate'],
    ['refunds keep failing for cancelled subscriptions', 'payments', 'InvoiceService'],
    ['users are getting logged out right after they sign in — sessions expire immediately', 'auth', 'LoginService'],
    ['fix the crash in the oauth callback when the provider returns no email', 'auth', 'LoginService'],
    ['people cannot log in even with the right password', 'auth', 'LoginService'],
    ['email verification never confirms new accounts', 'auth', 'AccountRegistration'],
    ['the vulnerability scanner misses advisories published yesterday', 'deps', 'VulnerabilityScanner'],
    ['fix stale results coming back from the advisory feed sync', 'deps', 'AdvisoryFeed'],
    ['emails go out with broken template rendering — fix the renderer', 'notify', 'EmailSender'],
    ['sms retries loop forever when delivery keeps failing', 'notify', 'SmsDispatcher'],
    ['the cart total ignores the discount code — fix it', 'shop', 'CartService'],
    ['orders get marked shipped but tracking never updates', 'shop', 'OrderFulfillment'],
    ['restocking does not update the product inventory count', 'shop', 'ProductCatalog'],
    ['fix duplicate chat messages appearing when a user edits a message', 'chat', 'ChatRoomService'],
    ['typing indicators never clear when someone goes offline', 'chat', 'PresenceTracker'],
    ['thumbnails come out black for some uploaded videos', 'media', 'VideoTranscoder'],
    ['playback stalls because the stream manifest is built wrong', 'media', 'PlaybackSession'],
    ['events get dropped when the analytics queue is flushed under load', 'analytics', 'EventTracker'],
    ['the conversion funnel double counts returning users', 'analytics', 'FunnelReport'],
    ['scheduled articles publish immediately instead of at the scheduled time', 'cms', 'ArticlePublisher'],
    ['frontmatter is not extracted from markdown pages', 'cms', 'MarkdownRenderer'],
    ['rolling back a deployment leaves the release half applied', 'ci', 'DeploymentManager'],
    ['a failed pipeline stage gets retried forever', 'ci', 'PipelineRunner'],
    ['push tokens are never unregistered when a device is removed', 'mobile', 'PushRegistration'],
    ['deep links open the wrong screen on ios', 'mobile', 'DeepLinkRouter'],
    ['the nightly settlement batch fails to reconcile some ledger entries', 'etl', 'batch_settlement'],
    ['fixed width exports pad numeric fields with spaces instead of zeros', 'etl', 'batch_settlement'],
    ['ebcdic conversion garbles records from the legacy system', 'etl', 'batch_settlement'],
    ['reverse geocoding returns the wrong address near tile boundaries', 'geo', 'GeocodingService'],
    ['arrival estimates are off by hours on long routes', 'geo', 'RoutePlanner'],
    ['missing translations fall back to raw keys instead of english', 'i18n', 'TranslationLoader'],
    ['dates are formatted wrong for some locales', 'i18n', 'LocaleFormatter'],
    ['prometheus metrics stop exporting after a counter overflows', 'observability', 'MetricsExporter'],
    ['trace spans lose their attributes when recorded concurrently', 'observability', 'TraceRecorder'],
    ['the rollout percentage is ignored and every user gets the feature flag', 'flags', 'FeatureFlagStore'],
    ['experiment variants get reassigned on every request', 'flags', 'ExperimentAssigner'],
  ];
  for (const [q, key, base] of FIXES) {
    add(`code-fix-${key}`, q, domain(d[key], base ? { expectAnyFiles: filesOf(d[key], base) } : {}));
  }

  // Wave 2: harder symptom phrasings — synonyms and colloquial domain words
  // that appear in no identifier ("double charged", "bounces", "draft").
  const FIXES2 = [
    ['customers are being double charged on payment retries', 'payments', null],
    ['password reset tokens expire way too quickly', 'auth', 'LoginService'],
    ['we accept weak passwords, tighten the validation rules', 'auth', 'LoginService'],
    ['the cve feed data is stale by a week', 'deps', null],
    ['transactional mail bounces are not handled at all', 'notify', 'EmailSender'],
    ['messages arrive out of order in busy chat rooms', 'chat', 'ChatRoomService'],
    ['video uploads stall at 99 percent during transcoding', 'media', 'VideoTranscoder'],
    ['draft articles show up on the public site before publishing', 'cms', 'ArticlePublisher'],
    ['deploys hang waiting for the previous release to finish', 'ci', 'DeploymentManager'],
    ['notifications stop after the app refreshes its push token', 'mobile', 'PushRegistration'],
    ['the reconciliation totals drift from the ledger by a few cents', 'etl', 'batch_settlement'],
    ['route distances come out wrong when crossing timezones', 'geo', 'RoutePlanner'],
    ['the plural forms are wrong for polish translations', 'i18n', null],
    ['spans end up orphaned when requests fan out', 'observability', 'TraceRecorder'],
    ['stale feature flags stay enabled after the experiment ends', 'flags', null],
  ];
  for (const [q, key, base] of FIXES2) {
    add(`code-fix-${key}`, q, domain(d[key], base ? { expectAnyFiles: filesOf(d[key], base) } : {}));
  }

  // ------------------------------------------------------------------
  // 1b. code-perf — performance complaints: the symptom is "slow", the
  //     topic is the domain. "slow"/"profile" must not carry seeds.
  // ------------------------------------------------------------------
  const PERF = [
    ['video transcoding is painfully slow, profile it and speed it up', 'media'],
    ['the conversion funnel query takes minutes over large date ranges', 'analytics'],
    ['cart total calculation is slow for carts with many items', 'shop'],
    ['geocoding lookups are slow, batch the requests', 'geo'],
    ['the advisory sync is slow and hammers the upstream api', 'deps'],
    ['rendering markdown is the slowest part of publishing', 'cms'],
  ];
  for (const [q, key] of PERF) add('code-perf', q, domain(d[key]));

  // ------------------------------------------------------------------
  // 2. code-impl-<domain> — imperative feature work, weak-verb heavy but
  //    topic-bearing. One step from the `add*` grab-bag: the topic must win.
  // ------------------------------------------------------------------
  const IMPLS = [
    ['add apple pay support to the checkout flow', 'payments'],
    ['implement retry with exponential backoff for stripe webhook processing', 'payments'],
    ['add remember me to the login flow', 'auth'],
    ['implement account lockout after repeated failed password attempts', 'auth'],
    ['add severity filtering when we audit dependencies for vulnerabilities', 'deps'],
    ['implement digest emails that batch notifications per user', 'notify'],
    ['add gift wrapping as an option on the shopping cart', 'shop'],
    ['implement read receipts for chat messages', 'chat'],
    ['add resumable uploads for large videos before transcoding', 'media'],
    ['implement sampling so we only track a percentage of analytics events', 'analytics'],
    ['add a preview mode for unpublished articles', 'cms'],
    ['implement blue green deployments alongside the canary rollout', 'ci'],
    ['add badge counts to push notifications on mobile devices', 'mobile'],
    ['implement checkpointing so the settlement batch can resume mid run', 'etl'],
    ['add caching for repeated geocode lookups of the same address', 'geo'],
    ['implement pluralization rules for locales with multiple plural forms', 'i18n'],
    ['add histogram buckets to the exported prometheus metrics', 'observability'],
    ['implement sticky bucketing so experiment variants stay stable per user', 'flags'],
  ];
  for (const [q, key] of IMPLS) add(`code-impl-${key}`, q, domain(d[key]));

  // ------------------------------------------------------------------
  // 3. code-test-writing — "write tests for X" must pin X's file. Names a
  //    real method or class; k=3 (a test-writing prompt that cannot find its
  //    subject in the top 3 has failed the developer).
  // ------------------------------------------------------------------
  {
    for (const dom of Object.values(d)) {
      // Every class gets a regression-test prompt; every other method gets a
      // unit-test prompt — full-name coverage across the whole scale range.
      for (const cls of dom.classes) {
        add('code-test-writing', `add a regression test covering ${cls.name} edge cases`, { expectFile: cls.file, k: 3 });
      }
      for (let i = 0; i < dom.methods.length; i += 2) {
        const m = dom.methods[i];
        add('code-test-writing', `write unit tests for ${m.name}`, { expectFile: m.file, k: 3 });
      }
    }
  }

  // ------------------------------------------------------------------
  // 4. code-refactor-named — refactor prompts naming a real symbol.
  // ------------------------------------------------------------------
  {
    for (const dom of Object.values(d)) {
      // Every other class, every third method — different stride from the
      // test-writing prompts so the two categories overlap only partially.
      for (let i = 0; i < dom.classes.length; i += 2) {
        const cls = dom.classes[i];
        add('code-refactor-named', `refactor ${cls.name} to extract the validation logic, keeping behaviour identical`, {
          expectFile: cls.file,
          k: 3,
        });
      }
      for (let i = 1; i < dom.methods.length; i += 3) {
        const m = dom.methods[i];
        add('code-refactor-named', `simplify ${m.name} without changing its return values`, { expectFile: m.file, k: 3 });
      }
    }
  }

  // ------------------------------------------------------------------
  // 5. code-path-hint — the prompt carries an exact repo path (or a stack
  //    trace naming one). The named file must pin.
  // ------------------------------------------------------------------
  const PATHED = [
    ['payments', 'StripeGateway', (f) => `fix the todo in ${f}`],
    ['auth', 'LoginService', (f) => `there is a bug somewhere in ${f} — find and fix it`],
    ['shop', 'CartService', (f) => `apply the review feedback to ${f}`],
    ['media', 'VideoTranscoder', (f) => `clean up the error handling in ${f}`],
    ['flags', 'FeatureFlagStore', (f) => `update ${f} to handle missing config`],
    ['etl', 'batch_settlement', (f) => `the numbers in ${f} drift after midnight — fix the window logic`],
  ];
  {
    let i = 0;
    for (const [key, base, tpl] of PATHED) {
      const f = pickFile(d[key], base, i++);
      add('code-path-hint', tpl(f), { expectFile: f, k: 3 });
    }
  }
  // More path templates across the remaining domains.
  const PATHED2 = [
    ['deps', 'AdvisoryFeed', (f) => `the retry logic in ${f} needs a cap`],
    ['notify', 'EmailSender', (f) => `dedupe the recipients list in ${f}`],
    ['analytics', 'FunnelReport', (f) => `add input validation to ${f}`],
    ['cms', 'MarkdownRenderer', (f) => `harden ${f} against malformed frontmatter`],
    ['mobile', 'DeepLinkRouter', (f) => `handle unknown routes in ${f}`],
    ['i18n', 'TranslationLoader', (f) => `make ${f} tolerate a missing bundle`],
    ['observability', 'TraceRecorder', (f) => `flush pending spans on shutdown in ${f}`],
  ];
  {
    let i = 2;
    for (const [key, base, tpl] of PATHED2) {
      const f = pickFile(d[key], base, i++);
      add('code-path-hint', tpl(f), { expectFile: f, k: 3 });
    }
  }
  // Stack-trace style: symbol + file:line, like a pasted error.
  {
    let i = 0;
    for (const key of ['payments', 'auth', 'chat', 'geo', 'shop', 'media', 'i18n', 'flags']) {
      const dom = d[key];
      const m = dom.methods[i % dom.methods.length];
      add('code-path-hint', `TypeError: cannot read properties of undefined at ${m.name} (${m.file}:14:7) — fix the crash`, {
        expectFile: m.file,
        k: 3,
      });
      i += 3;
    }
  }
  // Python traceback style for the batch domain.
  {
    const m = d.etl.methods[1];
    add('code-path-hint', `File "${m.file}", line 7, in ${m.name} — KeyError: 'entry', fix it`, { expectFile: m.file, k: 3 });
  }

  // ------------------------------------------------------------------
  // 6. code-error-quote — the topical evidence lives INSIDE a quoted error
  //    message. The quote is literal-locate material AND the only domain
  //    signal; seeds must still reach the owning domain.
  // ------------------------------------------------------------------
  const QUOTED = [
    ['the checkout fails with "sepa mandate missing" — fix it', 'payments', 'DirectDebitMandate'],
    ['we keep seeing "invoice already refunded" in the logs, figure out why', 'payments', 'InvoiceService'],
    ['login throws "session token expired" for brand new sessions', 'auth', 'LoginService'],
    ['the worker logs "advisory database sync failed" every night', 'deps', 'AdvisoryFeed'],
    ['users report "discount code invalid" for codes that should work', 'shop', 'CartService'],
    ['the app shows "stream manifest unavailable" on every playback attempt', 'media', 'PlaybackSession'],
    ['deploys abort with "rollback incomplete" — fix the underlying issue', 'ci', 'DeploymentManager'],
    ['the batch job dies with "ledger entry mismatch" halfway through', 'etl', 'batch_settlement'],
  ];
  for (const [q, key, base] of QUOTED) {
    add('code-error-quote', q, domain(d[key], { expectAnyFiles: filesOf(d[key], base) }));
  }
  const QUOTED2 = [
    ['signup fails with "email verification pending" forever', 'auth', 'AccountRegistration'],
    ['"template not found" when sending the welcome email', 'notify', 'EmailSender'],
    ['"room not found" when opening an existing conversation', 'chat', 'ChatRoomService'],
    ['transcodes fail with "unsupported codec" for valid files', 'media', 'VideoTranscoder'],
    ['"funnel step missing" shows up in the weekly report', 'analytics', 'FunnelReport'],
    ['"invalid device token" when sending pushes to android', 'mobile', 'PushRegistration'],
    ['"missing plural rule" for polish locales', 'i18n', 'LocaleFormatter'],
    ['"span already ended" warnings flood the collector', 'observability', 'TraceRecorder'],
    ['"unknown variant" when assigning users to experiments', 'flags', 'ExperimentAssigner'],
  ];
  for (const [q, key, base] of QUOTED2) {
    add('code-error-quote', q, domain(d[key], { expectAnyFiles: filesOf(d[key], base) }));
  }

  // ------------------------------------------------------------------
  // 7. code-multi-domain — the task spans two domains; seeds must cover both
  //    sides (at least one expected file from EACH side in top-k) and stay
  //    inside the union of the two domains.
  // ------------------------------------------------------------------
  const MULTI = [
    ['send an email when an order ships', 'notify', 'shop'],
    ['track an analytics event when a user signs up', 'analytics', 'auth'],
    ['send a push notification when a deploy finishes', 'mobile', 'ci'],
    ['translate the email templates into each locale', 'i18n', 'notify'],
    ['record a metric every time a feature flag is evaluated', 'observability', 'flags'],
    ['invoice the customer when their order is fulfilled', 'payments', 'shop'],
    ['geocode the shipping address when an order is placed', 'geo', 'shop'],
    ['show a localized error message when a payment fails', 'i18n', 'payments'],
    ['publish a changelog article when a release is deployed', 'cms', 'ci'],
    ['notify the customer by sms when their shipment is delivered', 'notify', 'shop'],
  ];
  for (const [q, a, b] of MULTI) {
    // Cross-domain coverage is judged over the FULL capsule seed window
    // (k=16, what buildCodeContext retrieves), not the top-8: the weaker
    // side of a two-sided task legitimately ranks below the stronger side's
    // whole file family, but it must still be in the window the capsule
    // expands.
    add('code-multi-domain', q, {
      k: 16,
      expectAnyFiles: d[a].files,
      expectAnyFilesB: d[b].files,
      domainDirs: [...d[a].dirs, ...d[b].dirs],
      minShare: 0.5,
      forbidFiles: distractorFiles,
      maxForbidden: 1,
    });
  }

  // ------------------------------------------------------------------
  // 8. code-trap-imperative — dense weak-verb phrasing wrapped around a real
  //    topic, with the distractor families (`add*`, `Add*Form`, `*Direct*`,
  //    `*Via*`) as forbidden files. Zero tolerance.
  // ------------------------------------------------------------------
  const TRAPS = [
    ['create a form to add a new payment method', 'payments'],
    ['make a quick way to add a discount to the cart', 'shop'],
    ['add the ability to create new chat rooms', 'chat'],
    ['set up a new way to add subscribers to the email list', 'notify'],
    ['add a new option to make deploys go via the canary pipeline', 'ci'],
    ['build a new form so users can add their bank account for direct debit', 'payments'],
  ];
  for (const [q, key] of TRAPS) add('code-trap-imperative', q, domain(d[key], { maxForbidden: 0 }));

  // ------------------------------------------------------------------
  // 9. code-typo — misspelled domain/product words. A single-character slip
  //    must not turn a well-scoped coding prompt into silence or noise.
  // ------------------------------------------------------------------
  const TYPOS = [
    ['fix the strpe webhook secret validation', 'payments', 'StripeWebhookHandler'],
    ['chekout is broken for guest users', 'payments', 'StripeGateway'],
    ['the invoce totals are wrong after a partial refund', 'payments', 'InvoiceService'],
    ['fix the oath callback redirect loop', 'auth', 'LoginService'],
    ['playbck keeps buffering on slow connections', 'media', 'PlaybackSession'],
    ['the geocde lookup times out for long addresses', 'geo', 'GeocodingService'],
    ['transaltions are missing for the settings page', 'i18n', 'TranslationLoader'],
    ['exprimant assignment flips between variants', 'flags', 'ExperimentAssigner'],
  ];
  for (const [q, key, base] of TYPOS) {
    add('code-typo', q, domain(d[key], { expectAnyFiles: filesOf(d[key], base) }));
  }
  const TYPOS2 = [
    ['the vulnerabilty scanner crashes on empty lockfiles', 'deps', 'VulnerabilityScanner'],
    ['the emal sender is down again', 'notify', 'EmailSender'],
    ['sheduled articles never publish', 'cms', 'ArticlePublisher'],
    ['the depoly pipeline is stuck', 'ci', null],
    ['push notifcations are delayed by hours', 'mobile', 'PushRegistration'],
    ['the trnaslation loader drops keys on reload', 'i18n', 'TranslationLoader'],
    ['metrcis are missing from the exporter', 'observability', 'MetricsExporter'],
    ['the inventroy count is off after a restock', 'shop', 'ProductCatalog'],
  ];
  for (const [q, key, base] of TYPOS2) {
    add('code-typo', q, domain(d[key], base ? { expectAnyFiles: filesOf(d[key], base) } : {}));
  }

  // ------------------------------------------------------------------
  // 10. code-colloquial — how developers actually phrase it in a hurry.
  // ------------------------------------------------------------------
  const COLLOQUIAL = [
    ["checkout's busted, nobody can pay", 'payments'],
    ["the login page is borked again", 'auth'],
    ['shipping info never shows up on orders', 'shop'],
    ['chat is eating messages', 'chat'],
    ['vids take forever to transcode', 'media'],
    ['deploys are flaky, sort out the pipeline', 'ci'],
  ];
  for (const [q, key] of COLLOQUIAL) add('code-colloquial', q, domain(d[key]));
  const COLLOQUIAL2 = [
    ['folks keep getting double billed', 'payments'],
    ['the deploy thingy is stuck again', 'ci'],
    ['srsly the chat is lagging for everyone', 'chat'],
    ['push notifs never show up on my phone', 'mobile'],
    ['the exchange rate bit on invoices is off', 'payments'],
    ['i18n strings are all messed up on the settings page', 'i18n'],
  ];
  for (const [q, key] of COLLOQUIAL2) add('code-colloquial', q, domain(d[key]));

  // ------------------------------------------------------------------
  // 11. Honest misses. Weak-only coding prompts ("fix the bug") and
  //     off-topic prompts must return an empty seed list, not a grab-bag.
  // ------------------------------------------------------------------
  for (const q of [
    'fix the bug',
    'clean up the code',
    'make it faster please',
    'refactor this',
    'tidy this file up',
    'address the review comments',
    'can you take a look',
    'something is off, not sure what',
    'improve performance',
    'ship it',
  ]) {
    add('code-weak-must-miss', q, { mustMiss: true });
  }
  for (const q of [
    'fix the quaternion slerp jitter in the animation rig',
    'optimize the voxel mesh greedy merge pass',
    'the fft window function clips at the nyquist bin',
    'the kalman filter diverges when gps dropouts exceed a second',
    'rewrite the bloom filter with simd intrinsics',
  ]) {
    add('code-offtopic-must-miss', q, { mustMiss: true });
  }

  return c;
}

/**
 * Evaluate one seed list against a code-corpus entry. Delegates the shared
 * fields to `evaluateAskEntry` (bench/ask-corpus.mjs) and adds the one field
 * this corpus introduces: `expectAnyFilesB` (a second, independent "at least
 * one of these in top-k" set, for multi-domain prompts).
 */
export function evaluateCodeEntry(entry, seeds, evaluateAskEntry) {
  const base = evaluateAskEntry(entry, seeds);
  if (!base.pass) return base;
  if (entry.expectAnyFilesB) {
    const norm = (f) => f.replace(/\\/g, '/').replace(/^\.\//, '');
    const files = seeds.slice(0, entry.k ?? 8).map((s) => norm(s.file));
    const want = entry.expectAnyFilesB.map(norm);
    if (!files.some((f) => want.includes(f))) {
      return { pass: false, reason: `no file from the second domain in top-${entry.k}, got [${files.join(', ')}]` };
    }
  }
  return { pass: true };
}
