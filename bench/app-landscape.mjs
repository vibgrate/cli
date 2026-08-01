/**
 * The app landscape: which languages and app categories developers actually
 * build in, and how the ask-quality corpus covers them.
 *
 * This is the coverage contract for `vg ask` / Task Capsule relevance: the
 * ranker must answer questions "on any topic that is most likely to come up",
 * so the topics are enumerated HERE, weighted by real-world popularity, and the
 * quality gate asserts every in-scope category maps to at least one intent
 * fixture domain pack and at least one corpus question category. Adding a
 * category here without fixture/corpus coverage fails the gate — coverage debt
 * is visible, never silent.
 *
 * Popularity notes are approximate, labeled, and sourced from public industry
 * data as of 2025: Stack Overflow Developer Survey 2024/2025 (language usage),
 * GitHub Octoverse 2024 (Python overtook JavaScript as #1 by contributors;
 * TypeScript #3 and rising), JetBrains DevEcosystem 2024. They guide breadth,
 * not precision — the gate never asserts on the numbers themselves.
 */

/** Languages ranked by developer usage (approx % of professional developers
 *  using each, SO Survey 2024/2025 bands), annotated with graph support. */
export const LANGUAGES = [
  { id: 'javascript', usage: '~62%', graphSupport: true, note: 'Web + Node; #1 SO usage for a decade, #2 Octoverse contributors' },
  { id: 'python', usage: '~51%', graphSupport: true, note: '#1 Octoverse 2024 contributors; data/ML, backends, scripting, ETL' },
  { id: 'typescript', usage: '~38%', graphSupport: true, note: 'Fastest-growing major language; default for new web apps' },
  { id: 'java', usage: '~30%', graphSupport: true, note: 'Enterprise backends, Android, Spring' },
  { id: 'csharp', usage: '~27%', graphSupport: true, note: '.NET web/desktop/games (Unity), enterprise' },
  { id: 'cpp', usage: '~23%', graphSupport: true, note: 'Systems, games, embedded' },
  { id: 'php', usage: '~18%', graphSupport: true, note: 'WordPress/Laravel; huge deployed web base' },
  { id: 'go', usage: '~14%', graphSupport: true, note: 'Cloud infra, services, CLIs' },
  { id: 'rust', usage: '~13%', graphSupport: true, note: 'Systems, CLI, wasm; most-admired repeatedly' },
  { id: 'kotlin', usage: '~9%', graphSupport: true, note: 'Android default, JVM backends' },
  { id: 'swift', usage: '~5%', graphSupport: true, note: 'iOS/macOS apps' },
  { id: 'ruby', usage: '~5%', graphSupport: true, note: 'Rails web apps' },
  { id: 'dart', usage: '~6%', graphSupport: true, note: 'Flutter cross-platform mobile' },
  { id: 'cobol', usage: '<1% of devs, ~70% of Fortune-500 batch transaction volume', graphSupport: false, note: 'Mainframe batch/CICS; concepts covered via the ETL/batch domain pack (settlement, fixed-width records, reconciliation) — grammar not yet shipped' },
];

/**
 * App categories by where coding-agent development actually happens, each
 * mapped to the intent-fixture domain packs and corpus intent categories that
 * cover its typical questions. `fixtureDomains: []` + `outOfScope` documents an
 * explicit, reviewed gap instead of a silent one.
 */
export const APP_CATEGORIES = [
  {
    key: 'web-saas',
    label: 'Web apps / SaaS dashboards',
    note: 'The largest category on GitHub by repo count; TS/JS dominant',
    fixtureDomains: ['auth', 'notify', 'flags', 'i18n'],
    repoExamples: ['calcom', 'nextjs-enterprise-saas', 'strapi'],
  },
  {
    key: 'ecommerce',
    label: 'E-commerce / marketplaces',
    note: 'Carts, catalogs, orders, fulfilment; payments adjacent',
    fixtureDomains: ['shop', 'payments'],
    repoExamples: ['saleor', 'python-django'],
  },
  {
    key: 'fintech-payments',
    label: 'Payments / fintech / billing',
    note: 'Stripe-style gateways, direct debit, invoicing — the field-report domain',
    fixtureDomains: ['payments'],
    repoExamples: ['eshoponcontainers'],
  },
  {
    key: 'social-messaging',
    label: 'Social / chat / messaging',
    note: 'Mobile + web; rooms, presence, threads, feeds',
    fixtureDomains: ['chat', 'notify'],
    repoExamples: [],
  },
  {
    key: 'media-streaming',
    label: 'Media / video / streaming',
    note: 'Transcoding, playback, thumbnails, manifests',
    fixtureDomains: ['media'],
    repoExamples: [],
  },
  {
    key: 'data-analytics',
    label: 'Analytics / BI / event tracking',
    note: 'Event pipelines, funnels, dashboards, metrics',
    fixtureDomains: ['analytics'],
    repoExamples: [],
  },
  {
    key: 'content-cms',
    label: 'Content / CMS / publishing',
    note: 'Articles, scheduling, markdown rendering',
    fixtureDomains: ['cms'],
    repoExamples: ['strapi'],
  },
  {
    key: 'devops-ci',
    label: 'DevOps / CI-CD / platform tooling',
    note: 'Pipelines, deploys, rollbacks; Go/TS heavy',
    fixtureDomains: ['ci'],
    repoExamples: [],
  },
  {
    key: 'mobile',
    label: 'Mobile apps (iOS/Android/cross-platform)',
    note: 'Push, deep links, device tokens; Kotlin/Swift/Dart/RN',
    fixtureDomains: ['mobile'],
    repoExamples: ['node-nx-enterprise'],
  },
  {
    key: 'mainframe-batch-etl',
    label: 'Mainframe batch / ETL / back-office processing',
    note: 'Settlement runs, reconciliation, fixed-width interchange — the concepts survive the COBOL→Python/Java rewrite wave',
    fixtureDomains: ['etl'],
    repoExamples: [],
  },
  {
    key: 'geo-maps',
    label: 'Geo / maps / logistics',
    note: 'Geocoding, routing, distance',
    fixtureDomains: ['geo'],
    repoExamples: [],
  },
  {
    key: 'observability',
    label: 'Observability / monitoring',
    note: 'Metrics, traces, exporters',
    fixtureDomains: ['observability'],
    repoExamples: [],
  },
  {
    key: 'security-supply-chain',
    label: 'Security / dependency / supply chain',
    note: 'Audits, advisories, vulnerability scanning',
    fixtureDomains: ['deps'],
    repoExamples: ['node-vuln-demo'],
  },
  {
    key: 'games',
    label: 'Games',
    note: 'Unity/Unreal/engine loops',
    fixtureDomains: [],
    outOfScope: 'Engine-loop vocabulary (render, entity, physics) pending a dedicated pack; C#/C++ grammar support already exists',
    repoExamples: [],
  },
  {
    key: 'embedded-iot',
    label: 'Embedded / IoT',
    note: 'Firmware, sensors, MQTT',
    fixtureDomains: [],
    outOfScope: 'C-centric firmware idioms pending; MQTT/sensor vocabulary candidate for a future pack',
    repoExamples: [],
  },
];

/** Categories the corpus must cover (i.e. not explicitly marked out of scope). */
export function inScopeCategories() {
  return APP_CATEGORIES.filter((c) => !c.outOfScope);
}
