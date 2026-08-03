/**
 * Term roles and deterministic concept expansion for `vg ask` / Task Capsule
 * seed ranking (engine/query.ts).
 *
 * Two failure modes motivated this module (field report, 2026-07):
 *
 * 1. Weak process verbs dominated intent asks. "what do i need to do to add
 *    payments via direct debit?" seeded every `add*` symbol in the repo
 *    (`addTeamMember`, `AddBlogForm`, `submitAdd`, …) because "add" scored on
 *    equal footing with "debit". Verbs that describe the ACTION the caller
 *    wants ("add", "create", "via") are not the TOPIC being asked about — they
 *    may corroborate a topic match but must never be a seed's sole evidence.
 *
 * 2. No conceptual pull. "payments" never reached `StripeGateway` /
 *    `InvoiceService` unless a symbol literally contained "payment". A small,
 *    static, product-domain lexicon (payments → stripe/billing/invoice/…,
 *    "direct debit" → sepa/bacs/mandate) closes the gap deterministically —
 *    no embeddings, no network, stable across runs.
 *
 * Everything here is pure data + pure functions: same question in, same
 * expansion out, so capsule ranking stays benchmarkable and pinnable.
 */

/**
 * Process verbs and feature-request scaffolding: words that describe what the
 * caller wants DONE, not what the code is ABOUT. They still contribute score
 * (down-weighted) to nodes that independently match a content term, but a node
 * matching only weak terms is suppressed — that is exactly the `add*` grab-bag
 * failure. Distinct from STOPWORDS (which are dropped outright): a weak term
 * still corroborates ("add … to scanDir" boosts an `addEntry` sibling of a
 * scanDir hit), it just cannot carry a seed alone.
 */
export const WEAK_TERMS = new Set([
  'add', 'adds', 'added', 'adding',
  'create', 'creates', 'created', 'creating',
  'make', 'makes', 'making', 'made',
  'new', 'newly',
  'remove', 'removes', 'removed', 'removing',
  'delete', 'deletes', 'deleted', 'deleting',
  'update', 'updates', 'updated', 'updating',
  'change', 'changes', 'changed', 'changing',
  'set', 'sets', 'setting', 'setup',
  'get', 'gets', 'getting',
  'use', 'uses', 'used', 'using',
  'want', 'wants', 'wanted',
  'do', 'does', 'doing', 'done',
  'support', 'supports', 'supported', 'supporting',
  'enable', 'enables', 'enabled', 'enabling',
  'disable', 'disables', 'disabled', 'disabling',
  'allow', 'allows', 'allowed',
  'implement', 'implements', 'implemented', 'implementing',
  'build', 'builds', 'building', 'built',
  'via', 'through', 'into', 'onto',
  'way', 'ways', 'thing', 'things', 'stuff',
  'feature', 'features', 'functionality',
  'method', 'methods', 'option', 'options', 'ability',
  'help', 'start', 'begin', 'work', 'works', 'working',
  'also', 'currently', 'properly', 'correctly', 'please',
  'happens', 'happen', 'something', 'somewhere',
  'step', 'steps', 'flow', 'process',
  'you', 'can',
]);

/**
 * Product-domain concept lexicon: question token → identifier vocabulary that
 * OWNS the concept in real codebases. Expansion terms score at a reduced tier
 * (EXPANSION_WEIGHT in query.ts) and count as content evidence, with the
 * provenance kept in the seed's `why` (`payments→stripe`).
 *
 * Keep entries conservative: every value should be a word a maintainer would
 * plausibly put in an identifier or directory name for that concept. Do not
 * add framing words ("code", "logic") — they are stopwords, not concepts.
 */
const CONCEPTS: Record<string, readonly string[]> = {
  // ---- payments / billing ----
  payment: ['stripe', 'billing', 'invoice', 'checkout', 'charge', 'subscription', 'refund', 'payout', 'card', 'debit', 'mandate'],
  pay: ['payment', 'stripe', 'charge', 'billing', 'invoice'],
  paid: ['payment', 'invoice', 'charge'],
  billing: ['invoice', 'payment', 'subscription', 'stripe', 'charge', 'renewal'],
  checkout: ['stripe', 'payment', 'cart', 'session'],
  debit: ['mandate', 'sepa', 'bacs', 'ach', 'bank', 'payment'],
  mandate: ['sepa', 'bacs', 'debit'],
  sepa: ['mandate', 'debit', 'iban', 'bank'],
  bacs: ['mandate', 'debit', 'bank'],
  ach: ['mandate', 'debit', 'bank'],
  stripe: ['payment', 'billing', 'checkout', 'webhook', 'charge', 'card'],
  refund: ['payment', 'invoice', 'stripe', 'charge'],
  invoice: ['billing', 'payment', 'refund', 'subscription'],
  subscription: ['billing', 'renewal', 'invoice', 'plan', 'recurring'],
  recurring: ['subscription', 'renewal', 'mandate', 'debit'],
  renewal: ['subscription', 'billing', 'renew'],
  card: ['payment', 'charge', 'stripe'],
  credit: ['card', 'payment', 'charge'],
  bank: ['debit', 'mandate', 'sepa', 'iban', 'account'],
  charge: ['payment', 'card', 'stripe'],
  webhook: ['event', 'handler', 'callback'],
  price: ['payment', 'billing', 'plan'],
  customer: ['billing', 'account', 'user'],
  // ---- auth ----
  auth: ['login', 'session', 'token', 'oauth', 'password', 'credential'],
  authentication: ['auth', 'login', 'session', 'token', 'password'],
  authenticated: ['auth', 'login', 'session'],
  login: ['auth', 'session', 'password', 'signin', 'oauth'],
  signin: ['login', 'auth', 'session'],
  signup: ['register', 'onboard', 'account'],
  logout: ['session', 'auth', 'signout'],
  password: ['auth', 'login', 'credential', 'hash'],
  session: ['auth', 'login', 'token'],
  token: ['session', 'auth', 'jwt'],
  oauth: ['auth', 'login', 'callback', 'provider'],
  google: ['oauth', 'login', 'auth'],
  github: ['oauth', 'login', 'auth'],
  sso: ['oauth', 'auth', 'saml', 'login'],
  credential: ['auth', 'password', 'token', 'secret'],
  // ---- dependencies / supply chain ----
  dependency: ['package', 'audit', 'vulnerability', 'advisory', 'lockfile', 'version'],
  package: ['dependency', 'audit', 'vulnerability', 'advisory', 'lockfile'],
  vulnerability: ['advisory', 'cve', 'osv', 'audit', 'vulnerable'],
  vulnerable: ['vulnerability', 'advisory', 'audit', 'cve'],
  advisory: ['vulnerability', 'cve', 'osv', 'audit'],
  cve: ['vulnerability', 'advisory', 'osv'],
  risk: ['vulnerability', 'audit', 'advisory'],
  security: ['vulnerability', 'audit', 'advisory'],
  audit: ['dependency', 'vulnerability', 'advisory'],
  scan: ['audit', 'vulnerability', 'scanner'],
  // ---- notifications / messaging ----
  email: ['mail', 'smtp', 'sender', 'template', 'message'],
  mail: ['email', 'smtp', 'sender'],
  notification: ['notify', 'email', 'sms', 'push', 'alert'],
  notify: ['notification', 'email', 'alert'],
  sms: ['notification', 'message', 'twilio'],
  // ---- e-commerce ----
  cart: ['checkout', 'order', 'shop', 'basket', 'discount'],
  basket: ['cart', 'checkout', 'order'],
  order: ['cart', 'shipment', 'fulfillment', 'shop', 'checkout'],
  ship: ['order', 'fulfillment', 'delivery', 'shipment'],
  shipment: ['order', 'fulfillment', 'delivery', 'track'],
  shipping: ['order', 'fulfillment', 'delivery', 'shipment'],
  shipped: ['order', 'fulfillment', 'shipment'],
  inventory: ['stock', 'product', 'catalog', 'restock'],
  stock: ['inventory', 'product', 'restock'],
  product: ['catalog', 'inventory', 'shop'],
  discount: ['coupon', 'promo', 'cart', 'price'],
  coupon: ['discount', 'promo', 'code'],
  // ---- chat / social ----
  chat: ['message', 'room', 'conversation', 'presence'],
  message: ['chat', 'sms', 'notification', 'thread'],
  conversation: ['chat', 'message', 'thread'],
  presence: ['online', 'typing', 'status'],
  online: ['presence', 'status'],
  typing: ['presence', 'indicator', 'broadcast'],
  // ---- media / streaming ----
  video: ['media', 'transcode', 'playback', 'stream', 'thumbnail'],
  stream: ['video', 'playback', 'manifest', 'media'],
  streaming: ['video', 'playback', 'manifest', 'media'],
  playback: ['video', 'stream', 'media', 'watch'],
  transcode: ['video', 'media', 'encode'],
  thumbnail: ['video', 'image', 'media'],
  media: ['video', 'stream', 'playback', 'asset'],
  // ---- analytics ----
  analytics: ['event', 'track', 'metric', 'funnel', 'report'],
  event: ['track', 'analytics', 'webhook'],
  track: ['event', 'analytics'],
  funnel: ['conversion', 'analytics', 'event'],
  conversion: ['funnel', 'analytics'],
  report: ['metrics', 'export', 'analytics'],
  // ---- content / CMS ----
  article: ['publish', 'content', 'post', 'cms'],
  publish: ['article', 'release', 'post', 'content'],
  post: ['article', 'publish', 'message'],
  blog: ['article', 'publish', 'post', 'cms'],
  content: ['cms', 'article', 'markdown'],
  markdown: ['render', 'article', 'content'],
  cms: ['article', 'content', 'publish'],
  // ---- CI / deployment ----
  deploy: ['release', 'rollback', 'pipeline', 'deployment'],
  deployment: ['deploy', 'release', 'rollback', 'pipeline'],
  release: ['deploy', 'version', 'rollback'],
  rollback: ['deploy', 'release', 'deployment'],
  pipeline: ['stage', 'deploy', 'runner', 'ci'],
  canary: ['deploy', 'rollout', 'release'],
  // ---- mobile ----
  push: ['notification', 'device', 'token', 'mobile'],
  device: ['push', 'token', 'mobile', 'register'],
  deeplink: ['link', 'route', 'universal'],
  mobile: ['push', 'device', 'deeplink', 'app'],
  ios: ['mobile', 'universal', 'link', 'app'],
  android: ['mobile', 'push', 'device', 'app'],
  // ---- batch / ETL / mainframe ----
  batch: ['settlement', 'job', 'etl', 'reconcile'],
  settlement: ['batch', 'reconcile', 'ledger', 'clearing'],
  reconcile: ['ledger', 'settlement', 'batch'],
  ledger: ['settlement', 'reconcile', 'balance', 'journal'],
  mainframe: ['batch', 'settlement', 'ebcdic', 'cobol', 'fixed'],
  ebcdic: ['mainframe', 'record', 'convert', 'legacy'],
  cobol: ['mainframe', 'batch', 'ebcdic'],
  etl: ['batch', 'pipeline', 'extract', 'load', 'transform'],
  nightly: ['batch', 'cron', 'schedule', 'job'],
  // ---- geo / maps ----
  geocode: ['address', 'location', 'map', 'geo'],
  address: ['geocode', 'location'],
  map: ['geo', 'route', 'location'],
  route: ['distance', 'path', 'planner', 'geo'],
  distance: ['route', 'haversine', 'geo'],
  location: ['geo', 'geocode', 'map'],
  arrival: ['route', 'eta', 'estimate'],
  // ---- i18n ----
  translation: ['locale', 'i18n', 'language', 'translate'],
  translate: ['translation', 'locale', 'language'],
  locale: ['translation', 'i18n', 'language', 'format'],
  i18n: ['translation', 'locale', 'language'],
  language: ['locale', 'translation', 'i18n'],
  localized: ['locale', 'translation', 'format'],
  // ---- observability ----
  metric: ['counter', 'prometheus', 'telemetry', 'export'],
  prometheus: ['metric', 'exporter', 'monitoring'],
  trace: ['span', 'telemetry', 'observability'],
  span: ['trace', 'telemetry'],
  monitoring: ['metric', 'trace', 'alert', 'observability'],
  telemetry: ['metric', 'trace', 'span'],
  counter: ['metric', 'increment'],
  // ---- feature flags / experimentation ----
  flag: ['feature', 'rollout', 'toggle', 'experiment'],
  rollout: ['flag', 'percentage', 'release', 'experiment'],
  toggle: ['flag', 'feature', 'switch'],
  experiment: ['variant', 'assign', 'flag', 'exposure'],
  variant: ['experiment', 'assign'],
  // ---- generic infrastructure ----
  database: ['schema', 'migration', 'sql', 'query', 'orm'],
  db: ['database', 'schema', 'migration', 'sql'],
  migration: ['database', 'schema', 'migrate', 'sql'],
  cache: ['redis', 'ttl', 'store'],
  queue: ['job', 'worker', 'task', 'batch'],
  job: ['queue', 'worker', 'cron'],
  upload: ['file', 'storage', 'blob', 'asset'],
  storage: ['file', 'upload', 'bucket', 'blob'],
  permission: ['role', 'rbac', 'acl', 'access', 'grant'],
  role: ['permission', 'rbac', 'access'],
  error: ['exception', 'failure', 'handler'],
  config: ['settings', 'env', 'configuration'],
};

/**
 * Adjacent-word concepts: phrases whose meaning is NOT the sum of their
 * tokens. "direct debit" is a payments concept; "direct" alone is a URL /
 * filesystem word (`validDirectUrl`, `directoryListing` — real distractors
 * from the field report). Detected over the RAW ordered token stream, before
 * stopword filtering, so "sign in" / "log in" survive.
 */
const BIGRAM_CONCEPTS: Record<string, readonly string[]> = {
  'direct debit': ['debit', 'mandate', 'sepa', 'bacs', 'bank'],
  'direct debits': ['debit', 'mandate', 'sepa', 'bacs', 'bank'],
  'sign in': ['login', 'signin', 'auth', 'session'],
  'signs in': ['login', 'signin', 'auth', 'session'],
  'log in': ['login', 'auth', 'session'],
  'logs in': ['login', 'auth', 'session'],
  'logged in': ['login', 'auth', 'session'],
  'sign up': ['signup', 'register', 'account'],
  'credit card': ['card', 'payment', 'charge', 'stripe'],
  'credit cards': ['card', 'payment', 'charge', 'stripe'],
  'bank transfer': ['bank', 'payment', 'sepa', 'transfer'],
  'rate limit': ['ratelimit', 'throttle', 'quota'],
  'two factor': ['totp', 'mfa', 'otp', 'auth'],
  'payment method': ['payment', 'stripe', 'card', 'debit'],
  'payment methods': ['payment', 'stripe', 'card', 'debit'],
  'push notification': ['push', 'device', 'token', 'notification'],
  'push notifications': ['push', 'device', 'token', 'notification'],
  'deep link': ['deeplink', 'link', 'route'],
  'deep links': ['deeplink', 'link', 'route'],
  'universal link': ['deeplink', 'link', 'universal'],
  'universal links': ['deeplink', 'link', 'universal'],
  'feature flag': ['flag', 'rollout', 'toggle', 'experiment'],
  'feature flags': ['flag', 'rollout', 'toggle', 'experiment'],
  'shopping cart': ['cart', 'checkout', 'order'],
  'roll back': ['rollback', 'deploy', 'release'],
  'rolled back': ['rollback', 'deploy', 'release'],
  'ab test': ['experiment', 'variant'],
  'sign out': ['logout', 'session', 'auth'],
  'fixed width': ['record', 'export', 'mainframe', 'batch'],
};

export interface ConceptExpansion {
  /** The expansion vocabulary term to score against symbol names. */
  term: string;
  /** The question token (or bigram) that produced it — kept for `why`. */
  from: string;
}

/** Singularize the trivial English plurals that show up in questions. */
function lexiconKey(token: string): string | null {
  if (token in CONCEPTS) return token;
  if (token.endsWith('ies')) {
    const singular = token.slice(0, -3) + 'y';
    if (singular in CONCEPTS) return singular;
  }
  if (token.endsWith('s')) {
    const singular = token.slice(0, -1);
    if (singular in CONCEPTS) return singular;
  }
  return null;
}

/**
 * Expand a question's ordered, lowercased token stream (stopwords INCLUDED —
 * bigrams like "sign in" need them) into concept vocabulary. Deterministic:
 * output order follows first appearance in the question, then lexicon order.
 * Tokens already present in the question are not re-emitted as expansions.
 */
export function expandConcepts(orderedTokens: string[]): ConceptExpansion[] {
  const present = new Set(orderedTokens);
  const out: ConceptExpansion[] = [];
  const emitted = new Set<string>();
  const emit = (term: string, from: string) => {
    if (present.has(term) || emitted.has(term)) return;
    emitted.add(term);
    out.push({ term, from });
  };

  for (let i = 0; i + 1 < orderedTokens.length; i++) {
    const bigram = `${orderedTokens[i]} ${orderedTokens[i + 1]}`;
    const terms = BIGRAM_CONCEPTS[bigram];
    if (terms) for (const t of terms) emit(t, bigram);
  }
  for (const token of orderedTokens) {
    const key = lexiconKey(token);
    if (key) for (const t of CONCEPTS[key]!) emit(t, token);
  }
  return out;
}

/**
 * Tokens CONSUMED by a fired bigram concept that carry no standalone domain
 * meaning of their own — "direct" in "direct debit", "sign" in "sign in".
 * The bigram's expansion vocabulary re-supplies the topical words (debit,
 * mandate, login, …), so the consumed token must stop acting as independent
 * content evidence: left at full weight it seeds every `directGet`/
 * `redirectUrl`/`directoryListing` in the repo — the exact distractor set the
 * BIGRAM_CONCEPTS comment above documents. A constituent that is itself a
 * lexicon concept ("debit", "card") keeps its content role.
 */
export function bigramConsumedTokens(orderedTokens: string[]): Set<string> {
  const consumed = new Set<string>();
  for (let i = 0; i + 1 < orderedTokens.length; i++) {
    const bigram = `${orderedTokens[i]} ${orderedTokens[i + 1]}`;
    if (!BIGRAM_CONCEPTS[bigram]) continue;
    for (const tok of [orderedTokens[i], orderedTokens[i + 1]]) {
      if (!lexiconKey(tok)) consumed.add(tok);
    }
  }
  return consumed;
}
