import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Intent fixture: a deterministic synthetic repo purpose-built to score `vg ask`
 * / Task Capsule seed RELEVANCE (not locate precision — that is xl-fixture.mjs).
 *
 * The repo is generated from DOMAIN_PACKS — a data-driven spec of domain-owned
 * code areas covering the app-category landscape in bench/app-landscape.mjs
 * (payments, auth, e-commerce, chat, media, analytics, CMS, CI/CD, mobile,
 * mainframe-style batch ETL, geo, i18n, observability, feature flags, …).
 * Adding a domain = adding a pack entry; the ask corpus (ask-corpus.mjs)
 * generates name-bearing and intent questions from the catalog automatically.
 *
 * It also contains distractor families that reproduce the reported capsule
 * failure verbatim ("what do i need to do to add payments via direct debit?"
 * seeded memberSideMap.add / AddBlogForm / validDirectUrl /
 * generateObjectViaResponsesAPI): generic `add*` admin forms, `*Direct*` URL
 * helpers, `*Via*` pipeline helpers — none related to any domain. A
 * relevance-correct ranker must keep them out of the seeds.
 *
 * No randomness: every file is a pure function of its index, and the catalog
 * records every domain's files and key symbols (with kinds) plus the full
 * distractor file list, so corpus expectations are machine-checkable.
 *
 * `scale` is the number of entities per family.
 */

/**
 * One generated file per pack entry per entity index. `cls` emits a class with
 * `methods`; `fns` emit standalone functions; `constName` emits a constant.
 * `lang: 'py'` emits snake_case Python (the ETL/batch pack — the mainframe
 * concepts that survived the COBOL rewrite wave live in Python/Java today).
 * All identifier names get the zero-padded entity tag appended (prefix-free at
 * any scale).
 */
export const DOMAIN_PACKS = [
  {
    key: 'payments',
    dirs: ['src/payments/', 'src/billing/'],
    files: [
      { dir: 'src/payments', base: 'StripeGateway', cls: 'StripeGateway', methods: ['createCheckoutSession', 'chargeCard'], constName: 'STRIPE_API_VERSION' },
      { dir: 'src/payments', base: 'DirectDebitMandate', cls: 'DirectDebitMandate', methods: ['createSepaMandate', 'collectBacsDebit'], fns: ['verifyBankAccount'] },
      { dir: 'src/payments', base: 'StripeWebhookHandler', fns: ['handleStripeWebhook', 'processPaymentIntent'] },
      { dir: 'src/billing', base: 'InvoiceService', cls: 'InvoiceService', methods: ['issueInvoice', 'refundPayment', 'renewSubscription'] },
    ],
    intents: [
      'explain where stripe is used',
      'how do we charge customers credit cards?',
      'where are invoices generated and refunds issued?',
      'add support for payment webhooks from stripe',
      'how do we handle stripe checkout sessions?',
      'where does subscription renewal billing happen?',
      'what code processes payment intents from webhooks?',
      'how are refunds processed when a customer cancels?',
    ],
  },
  {
    key: 'auth',
    dirs: ['src/auth/'],
    files: [
      { dir: 'src/auth', base: 'LoginService', cls: 'LoginService', methods: ['verifyPassword', 'issueSessionToken'], fns: ['handleOauthCallback'] },
      { dir: 'src/auth', base: 'AccountRegistration', cls: 'AccountRegistration', methods: ['registerAccount', 'confirmEmailVerification'] },
    ],
    intents: [
      'what do i need to do to add login with google?',
      'how do users sign in?',
      'where do we validate passwords?',
      'where are session tokens issued after authentication?',
      'how does the oauth callback flow work?',
      'add two factor authentication to the login flow',
    ],
  },
  {
    key: 'deps',
    // NOTE: not `src/deps/` — `deps` is a scanner-ignored directory name (discover.ts).
    dirs: ['src/security/'],
    files: [
      { dir: 'src/security', base: 'VulnerabilityScanner', cls: 'VulnerabilityScanner', methods: ['auditDependencies', 'fetchAdvisories'], constName: 'OSV_ENDPOINT' },
      { dir: 'src/security', base: 'AdvisoryFeed', cls: 'AdvisoryFeed', methods: ['syncAdvisoryDatabase', 'matchVulnerablePackages'] },
    ],
    intents: [
      'check for high risk dependencies',
      'which packages have known vulnerabilities?',
      'where do we audit dependencies against advisories?',
      'how do we scan for vulnerable dependencies?',
      'add a security audit step for our packages',
    ],
  },
  {
    key: 'notify',
    dirs: ['src/notifications/'],
    files: [
      { dir: 'src/notifications', base: 'EmailSender', cls: 'EmailSender', methods: ['sendEmail', 'renderTemplate'] },
      { dir: 'src/notifications', base: 'SmsDispatcher', cls: 'SmsDispatcher', methods: ['sendSmsMessage', 'retryFailedDelivery'] },
    ],
    intents: [
      'how do we send emails to users?',
      'where are email templates rendered?',
      'add an email notification when something happens',
      'where do we retry failed sms deliveries?',
    ],
  },
  {
    key: 'shop',
    dirs: ['src/shop/'],
    files: [
      { dir: 'src/shop', base: 'CartService', cls: 'CartService', methods: ['calculateCartTotal', 'applyDiscountCode'] },
      { dir: 'src/shop', base: 'OrderFulfillment', cls: 'OrderFulfillment', methods: ['shipOrder', 'trackShipment'] },
      { dir: 'src/shop', base: 'ProductCatalog', cls: 'ProductCatalog', methods: ['listProductInventory', 'restockInventory'] },
    ],
    intents: [
      'where do we calculate the shopping cart total?',
      'how are orders shipped and tracked?',
      'apply a discount code to the cart',
      'where is product inventory restocked?',
    ],
  },
  {
    key: 'chat',
    dirs: ['src/chat/'],
    files: [
      { dir: 'src/chat', base: 'ChatRoomService', cls: 'ChatRoomService', methods: ['postChatMessage', 'editChatMessage'] },
      { dir: 'src/chat', base: 'PresenceTracker', cls: 'PresenceTracker', methods: ['broadcastTypingIndicator', 'markUserOnline'] },
    ],
    intents: [
      'where do chat messages get posted and edited?',
      'how do we show who is online and typing?',
      'add message reactions to the chat room',
    ],
  },
  {
    key: 'media',
    dirs: ['src/media/'],
    files: [
      { dir: 'src/media', base: 'VideoTranscoder', cls: 'VideoTranscoder', methods: ['transcodeVideo', 'generateThumbnail'] },
      { dir: 'src/media', base: 'PlaybackSession', cls: 'PlaybackSession', methods: ['buildStreamManifest', 'recordWatchProgress'] },
    ],
    intents: [
      'how are videos transcoded after upload?',
      'where do we generate video thumbnails?',
      'how is the streaming manifest built for playback?',
    ],
  },
  {
    key: 'analytics',
    dirs: ['src/analytics/'],
    files: [
      { dir: 'src/analytics', base: 'EventTracker', cls: 'EventTracker', methods: ['trackEvent', 'flushEventQueue'] },
      { dir: 'src/analytics', base: 'FunnelReport', cls: 'FunnelReport', methods: ['computeConversionFunnel', 'exportMetricsReport'] },
    ],
    intents: [
      'where do we track user events?',
      'how is the conversion funnel computed?',
      'add an export for the metrics report',
    ],
  },
  {
    key: 'cms',
    dirs: ['src/cms/'],
    files: [
      { dir: 'src/cms', base: 'ArticlePublisher', cls: 'ArticlePublisher', methods: ['publishArticle', 'scheduleArticle'] },
      { dir: 'src/cms', base: 'MarkdownRenderer', cls: 'MarkdownRenderer', methods: ['renderMarkdownBody', 'extractFrontmatter'] },
    ],
    intents: [
      'how are articles published and scheduled?',
      'where is markdown rendered for content pages?',
      'add scheduling for blog posts',
    ],
  },
  {
    key: 'ci',
    dirs: ['src/ci/'],
    files: [
      { dir: 'src/ci', base: 'PipelineRunner', cls: 'PipelineRunner', methods: ['runPipelineStage', 'retryFailedStage'] },
      { dir: 'src/ci', base: 'DeploymentManager', cls: 'DeploymentManager', methods: ['deployRelease', 'rollbackDeployment'] },
    ],
    intents: [
      'how do we deploy a release and roll it back?',
      'where are pipeline stages run and retried?',
      'add a canary step to the deployment pipeline',
    ],
  },
  {
    key: 'mobile',
    dirs: ['src/mobile/'],
    files: [
      { dir: 'src/mobile', base: 'PushRegistration', cls: 'PushRegistration', methods: ['registerDeviceToken', 'unregisterDevice'] },
      { dir: 'src/mobile', base: 'DeepLinkRouter', cls: 'DeepLinkRouter', methods: ['resolveDeepLink', 'buildUniversalLink'] },
    ],
    intents: [
      'how do push notifications get registered on devices?',
      'where are deep links resolved?',
      'add universal links for the ios app',
    ],
  },
  {
    key: 'etl',
    dirs: ['src/batch/'],
    files: [
      {
        dir: 'src/batch',
        base: 'batch_settlement',
        lang: 'py',
        cls: 'BatchSettlement',
        methods: ['reconcile_ledger_entries', 'export_fixed_width_records'],
        fns: ['convert_ebcdic_record'],
        constName: 'SETTLEMENT_WINDOW',
      },
    ],
    intents: [
      'where does the nightly settlement batch reconcile the ledger?',
      'how do we export fixed width records for the mainframe?',
      'convert ebcdic records from the legacy system',
    ],
  },
  {
    key: 'geo',
    dirs: ['src/geo/'],
    files: [
      { dir: 'src/geo', base: 'GeocodingService', cls: 'GeocodingService', methods: ['geocodeAddress', 'reverseGeocode'] },
      { dir: 'src/geo', base: 'RoutePlanner', cls: 'RoutePlanner', methods: ['computeRouteDistance', 'estimateArrivalTime'] },
    ],
    intents: [
      'where do we geocode addresses?',
      'how is the route distance computed?',
      'estimate the arrival time for an order',
    ],
  },
  {
    key: 'i18n',
    dirs: ['src/i18n/'],
    files: [
      { dir: 'src/i18n', base: 'TranslationLoader', cls: 'TranslationLoader', methods: ['loadLocaleBundle', 'resolveMissingTranslation'] },
      { dir: 'src/i18n', base: 'LocaleFormatter', cls: 'LocaleFormatter', methods: ['formatLocalizedDate', 'pluralizeMessage'] },
    ],
    intents: [
      'where are locale bundles loaded?',
      'how do we handle missing translations?',
      'format dates for different locales',
    ],
  },
  {
    key: 'observability',
    dirs: ['src/observability/'],
    files: [
      { dir: 'src/observability', base: 'MetricsExporter', cls: 'MetricsExporter', methods: ['exportPrometheusMetrics', 'incrementCounterMetric'] },
      { dir: 'src/observability', base: 'TraceRecorder', cls: 'TraceRecorder', methods: ['recordTraceSpan', 'attachSpanAttributes'] },
    ],
    intents: [
      'where are prometheus metrics exported?',
      'how do we record trace spans?',
      'add a counter metric for requests',
    ],
  },
  {
    key: 'flags',
    dirs: ['src/flags/'],
    files: [
      { dir: 'src/flags', base: 'FeatureFlagStore', cls: 'FeatureFlagStore', methods: ['evaluateFeatureFlag', 'setRolloutPercentage'] },
      { dir: 'src/flags', base: 'ExperimentAssigner', cls: 'ExperimentAssigner', methods: ['assignExperimentVariant', 'logExposureEvent'] },
    ],
    intents: [
      'how do feature flags get evaluated?',
      'where do we set the rollout percentage for an experiment?',
      'assign users to experiment variants',
    ],
  },
];

/** Directory prefixes that OWN each domain (used by corpus share assertions). */
export const DOMAIN_DIRS = Object.fromEntries(DOMAIN_PACKS.map((p) => [p.key, p.dirs]));

class FileBuilder {
  constructor(rel) {
    this.rel = rel;
    this.lines = [];
  }
  push(s) {
    this.lines.push(s);
    return this.lines.length;
  }
  write(root, filler) {
    const comment = this.rel.endsWith('.py') ? '#' : '//';
    for (let k = 0; k < filler; k++) this.lines.push(`${comment} filler ${k} — padding so the scanner reads real bytes`);
    const abs = path.join(root, this.rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, this.lines.join('\n') + '\n');
  }
}

function emitTsFile(f, spec, t) {
  if (spec.constName) f.push(`export const ${spec.constName}_${t} = 'v${t}';`);
  if (spec.cls) {
    f.push(`export class ${spec.cls}${t} {`);
    for (const m of spec.methods ?? []) {
      f.push(`  ${m}${t}(input: string): string {`);
      f.push(`    return input + '${t}';`);
      f.push('  }');
    }
    f.push('}');
  }
  for (const fn of spec.fns ?? []) {
    f.push(`export function ${fn}${t}(value: string): boolean {`);
    f.push('  return value.length > 0;');
    f.push('}');
  }
}

function emitPyFile(f, spec, t) {
  if (spec.constName) f.push(`${spec.constName}_${t} = "v${t}"`);
  if (spec.cls) {
    f.push(`class ${spec.cls}${t}:`);
    for (const m of spec.methods ?? []) {
      f.push(`    def ${m}_${t}(self, value):`);
      f.push(`        return value`);
    }
  }
  for (const fn of spec.fns ?? []) {
    f.push(`def ${fn}_${t}(value):`);
    f.push('    return value');
  }
}

/**
 * Generate the repo under a fresh temp dir (or `destRoot` when given). Returns
 * `{ root, scale, catalog }`. Filler lines are appended AFTER recorded lines so
 * file mass is tunable without moving symbols.
 */
export function generateIntentRepo(scale = 4, filler = Number(process.env.BENCH_LINES ?? 8), destRoot = null) {
  let root;
  if (destRoot) {
    root = path.resolve(destRoot);
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true });
  } else {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-intent-'));
  }

  const catalog = {
    scale,
    /** key → { key, dirs, intents, files, classes:[{name,file}], methods:[{name,file}], symbols:[{name,file,kind}] } */
    domains: {},
    /** Files that must NOT dominate intent seeds (generic add/direct/via traps). */
    distractors: { files: [], symbols: [] },
  };
  for (const pack of DOMAIN_PACKS) {
    catalog.domains[pack.key] = {
      key: pack.key,
      dirs: pack.dirs,
      intents: pack.intents,
      files: [],
      classes: [],
      methods: [],
      symbols: [],
    };
  }

  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'intent-fixture', type: 'module', dependencies: { stripe: '^14.0.0' } }, null, 2) + '\n',
  );

  const distractor = (file, names) => {
    catalog.distractors.files.push(file);
    catalog.distractors.symbols.push(...names.map((name) => ({ name, file })));
  };

  for (let i = 0; i < scale; i++) {
    // Zero-padded tag keeps every identifier prefix-free at any scale.
    const t = String(i).padStart(3, '0');

    for (const pack of DOMAIN_PACKS) {
      const dom = catalog.domains[pack.key];
      for (const spec of pack.files) {
        const isPy = spec.lang === 'py';
        const rel = isPy ? `${spec.dir}/${spec.base}_${t}.py` : `${spec.dir}/${spec.base}${t}.ts`;
        const f = new FileBuilder(rel);
        if (isPy) emitPyFile(f, spec, t);
        else emitTsFile(f, spec, t);
        f.write(root, filler);

        dom.files.push(rel);
        const sep = isPy ? '_' : '';
        if (spec.cls) {
          const name = `${spec.cls}${t}`;
          dom.classes.push({ name, file: rel });
          dom.symbols.push({ name, file: rel, kind: 'class' });
        }
        for (const m of spec.methods ?? []) {
          const name = isPy ? `${m}_${t}` : `${m}${sep}${t}`;
          dom.methods.push({ name, file: rel });
          dom.symbols.push({ name, file: rel, kind: 'method' });
        }
        for (const fn of spec.fns ?? []) {
          const name = isPy ? `${fn}_${t}` : `${fn}${sep}${t}`;
          dom.symbols.push({ name, file: rel, kind: 'function' });
        }
        if (spec.constName) dom.symbols.push({ name: `${spec.constName}_${t}`, file: rel, kind: 'constant' });
      }
    }

    // ---- DISTRACTORS: the exact surface-form traps from the field report ----
    // Generic `add*` admin/team functions ("add" must never carry a domain ask).
    {
      const f = new FileBuilder(`src/admin/TeamAdmin${t}.ts`);
      f.push(`export function addTeamMember${t}(teamId: string, userId: string): boolean {`);
      f.push('  return teamId.length > 0 && userId.length > 0;');
      f.push('}');
      f.push(`export function addOrganizationSeat${t}(orgId: string): number {`);
      f.push('  return orgId.length;');
      f.push('}');
      f.write(root, filler);
      distractor(f.rel, [`addTeamMember${t}`, `addOrganizationSeat${t}`]);
    }
    // `Add*Form` UI components.
    {
      const f = new FileBuilder(`src/admin/ContentForms${t}.tsx`);
      f.push(`export function AddBlogForm${t}(props: { title: string }) {`);
      f.push('  return <form>{props.title}</form>;');
      f.push('}');
      f.push(`export function AddPollForm${t}(props: { question: string }) {`);
      f.push('  return <form>{props.question}</form>;');
      f.push('}');
      f.write(root, filler);
      distractor(f.rel, [`AddBlogForm${t}`, `AddPollForm${t}`]);
    }
    // `*Direct*` URL helpers ("direct" without "debit" context is not payments).
    {
      const f = new FileBuilder(`src/lib/contentOpportunities${t}.ts`);
      f.push(`export function validDirectUrl${t}(value: string): boolean {`);
      f.push(`  return value.startsWith('https://');`);
      f.push('}');
      f.push(`export function directoryListing${t}(dir: string): string[] {`);
      f.push('  return [dir];');
      f.push('}');
      f.write(root, filler);
      distractor(f.rel, [`validDirectUrl${t}`, `directoryListing${t}`]);
    }
    // `*Via*` pipeline helpers + a generic `submitAdd*`.
    {
      const f = new FileBuilder(`src/lib/analysisHelpers${t}.ts`);
      f.push(`export async function generateObjectViaResponsesApi${t}(prompt: string): Promise<string> {`);
      f.push('  return prompt;');
      f.push('}');
      f.push(`export function submitAddNote${t}(noteId: string): boolean {`);
      f.push('  return noteId.length > 0;');
      f.push('}');
      f.write(root, filler);
      distractor(f.rel, [`generateObjectViaResponsesApi${t}`, `submitAddNote${t}`]);
    }
    // Plain noise, no trap terms at all.
    {
      const f = new FileBuilder(`src/misc/Formatting${t}.ts`);
      f.push(`export function formatBanner${t}(title: string): string {`);
      f.push('  return title.toUpperCase();');
      f.push('}');
      f.write(root, filler);
    }
  }

  return { root, scale, catalog };
}
