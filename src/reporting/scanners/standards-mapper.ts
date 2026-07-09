/**
 * Offline purpose -> standards matcher.
 *
 * Infers each project's coarse purpose from signals the scan already collected
 * (project type, detected frameworks, architecture archetype, UI evidence,
 * service/API surface) and maps that purpose onto the recommended set of
 * standards from the bundled catalog index. No network, no LLM — deterministic
 * and safe to run on every scan. Deep LLM-backed compliance analysis is a
 * separate opt-in command (see the compliance-scan plan).
 */
import type {
  ProjectScan,
  ExtendedScanResults,
  ProjectPurpose,
  RecommendedStandard,
  StandardsRecommendations,
  CompactUiPurpose,
} from '../../core-open/index.js';
import { standardsIndex, complianceFrameworks, type StandardIndexEntry } from '../data/standards-index.js';

// Framework detection must cover ALL languages Vibgrate scans (Node/TS, .NET,
// Java/Kotlin/Scala, Python, Go, Rust, Ruby, PHP, Elixir, Swift, Dart), not just
// JavaScript. Matched (word-bounded) against detected framework names, which are
// short canonical strings, so boundaries keep short tokens (gin/chi/echo) safe.

// Frontend / web-UI frameworks → 'web-app'.
const WEB_FRAMEWORK_RE = new RegExp(
  '\\b(' +
    [
      // JS/TS UI
      'react', 'preact', 'next(?:\\.?js)?', 'remix', 'gatsby', 'vue', 'nuxt', 'angular',
      'svelte(?:kit)?', 'solid(?:js|start)?', 'qwik', 'astro', 'ember', 'backbone', 'alpine',
      'htmx', 'hotwire', 'turbo', 'stimulus', 'inertia',
      // .NET UI
      'blazor', 'razor', 'maui', 'wpf', 'winforms', 'xamarin', 'uno',
      // Java/Kotlin/Scala UI
      'jsf', 'thymeleaf', 'vaadin', 'wicket', 'gwt', 'compose(?: multiplatform)?',
      // PHP UI
      'livewire', 'filament', 'blade',
      // Mobile / cross-platform UI
      'flutter', 'swiftui', 'jetpack', 'react native',
    ].join('|') +
    ')\\b',
);

// Backend / server / API frameworks → 'api'.
const API_FRAMEWORK_RE = new RegExp(
  '\\b(' +
    [
      // Node/TS
      'express', 'fastify', 'nest(?:js)?', 'koa', 'hapi', 'hono', 'adonis', 'sails',
      'loopback', 'restify', 'feathers', 'h3', 'nitro', 'trpc',
      // Python
      'django', 'flask', 'fastapi', 'starlette', 'tornado', 'pyramid', 'sanic', 'aiohttp',
      'bottle', 'falcon', 'cherrypy', 'quart', 'litestar', 'connexion',
      // Java / Kotlin / Scala
      'spring(?:boot)?', 'quarkus', 'micronaut', 'vert\\.?x', 'dropwizard', 'jersey',
      'jax-?rs', 'struts', 'javalin', 'helidon', 'jhipster', 'ktor', 'http4s', 'finatra',
      'scalatra', 'lagom', 'play', 'akka(?: ?http)?', 'spark java', 'ratpack',
      // .NET
      'asp\\.?net(?: ?core)?', 'signalr', 'nancy', 'servicestack', 'carter', 'minimal ?api',
      'web ?api', 'mvc',
      // Go
      'gin', 'echo', 'fiber', 'chi', 'gorilla', 'beego', 'revel', 'buffalo', 'iris',
      'gqlgen', 'mux', 'fasthttp',
      // Ruby
      'rails', 'sinatra', 'hanami', 'grape', 'padrino', 'roda', 'rack',
      // PHP
      'laravel', 'symfony', 'codeigniter', 'slim', 'lumen', 'yii', 'cakephp', 'phalcon',
      'laminas', 'zend', 'fuel',
      // Rust
      'actix', 'axum', 'rocket', 'warp', 'tide', 'poem', 'salvo', 'hyper',
      // Elixir
      'phoenix', 'plug', 'cowboy',
      // Swift / Dart
      'vapor', 'kitura', 'hummingbird', 'perfect', 'shelf', 'aqueduct', 'conduit',
    ].join('|') +
    ')\\b',
);

// Non-JS frameworks usually appear inside dependency/package names in compound
// form (e.g. "spring-boot-starter-web", "django-rest-framework",
// "Microsoft.AspNetCore.App", "springdoc-openapi-starter-webmvc-ui"), so we also
// substring-match a curated set of *distinctive* framework stems against the
// dependency list. Only unambiguous stems (>=5 chars / clearly framework-y) go
// here; short/ambiguous names (gin, echo, chi, play, rack, iris…) are matched
// word-bounded against detected framework names above, where they are safe.
const API_DEP_STEMS = [
  'springframework', 'spring-boot', 'springdoc', 'webflux', 'webmvc', 'quarkus', 'micronaut',
  'dropwizard', 'jersey', 'resteasy', 'javalin', 'helidon', 'vertx', 'ratpack', 'restlet',
  'django', 'fastapi', 'starlette', 'tornado', 'pyramid', 'sanic', 'aiohttp', 'litestar', 'falcon-', 'flask',
  'express', 'fastify', 'nestjs', '@nestjs', 'adonis', 'loopback', 'feathers', 'restify',
  'aspnetcore', 'asp.net', 'servicestack', 'signalr',
  'gin-gonic', 'gorilla/mux', 'gofiber', 'beego', 'buffalo', 'gqlgen',
  'laravel', 'symfony', 'codeigniter', 'cakephp', 'phalcon', 'laminas', 'lumen',
  'sinatra', 'hanami', 'grape',
  'actix', 'axum', 'rocket', 'salvo', 'warp-',
  'phoenix', 'cowboy',
  'vapor', 'kitura', 'hummingbird', 'perfect-', 'aqueduct', 'conduit',
  'rails', 'railties', 'actionpack',
];
const WEB_DEP_STEMS = [
  'react', 'preact', 'next', 'nuxt', 'remix', 'gatsby', 'vue', 'angular', '@angular', 'svelte',
  'solid-js', 'qwik', 'astro', 'ember', 'backbone',
  'blazor', 'razor', 'vaadin', 'thymeleaf', 'wicket',
  'livewire', 'filament', 'inertia',
  'flutter', 'jetpack', 'swiftui',
];

function matchesStem(haystack: string, stems: string[]): boolean {
  return stems.some((s) => haystack.includes(s));
}

// Data / analytics signals.
const ML_RE = /\b(tensorflow|pytorch|torch|keras|jax|sklearn|scikit-?learn|pandas|numpy|scipy|xgboost|lightgbm|catboost|mxnet|spacy|transformers|huggingface|langchain|llama|onnx|mlflow|kubeflow|sagemaker|spark ?ml|mllib)\b/;
const INFRA_RE = /\b(terraform|pulumi|kubernetes|\bk8s\b|helm|ansible|cdktf|aws cdk|\bcdk\b|bicep|crossplane|serverless framework|\bsst\b|cloudformation|packer|nomad)\b/;

function archetypeCategory(archetype?: string): { category: string; signal: string } | null {
  switch (archetype) {
    case 'nextjs':
    case 'remix':
    case 'sveltekit':
    case 'nuxt':
      return { category: 'web-app', signal: `archetype:${archetype}` };
    case 'nestjs':
    case 'express':
    case 'fastify':
    case 'hono':
    case 'koa':
    case 'serverless':
      return { category: 'api', signal: `archetype:${archetype}` };
    case 'library':
      return { category: 'library', signal: 'archetype:library' };
    case 'cli':
      return { category: 'cli', signal: 'archetype:cli' };
    default:
      return null;
  }
}

/**
 * Infer a project's coarse purpose. Combines the strongest available signals;
 * confidence rises when multiple signals agree.
 */
export function inferProjectPurpose(
  project: ProjectScan,
  uiPurpose?: CompactUiPurpose,
): ProjectPurpose {
  const signals: string[] = [];
  const votes: Record<string, number> = {};
  const vote = (category: string, weight: number, signal: string) => {
    votes[category] = (votes[category] ?? 0) + weight;
    signals.push(signal);
  };

  // The archetype fingerprint is a Node/TS concept — only trust it for those.
  if (project.type === 'node' || project.type === 'typescript') {
    const arch = archetypeCategory(project.architecture?.archetype);
    if (arch) vote(arch.category, 3, arch.signal);
  }

  const fwNames = (project.frameworks ?? []).map((f) => f.name.toLowerCase());
  const uiFw = (uiPurpose?.detectedFrameworks ?? []).map((f) => f.toLowerCase());
  const fwText = [...fwNames, ...uiFw].join(' ');
  if (WEB_FRAMEWORK_RE.test(fwText)) vote('web-app', 2, 'web-framework');
  if (API_FRAMEWORK_RE.test(fwText)) vote('api', 2, 'api-framework');

  // Cross-language: frameworks usually appear inside dependency package names.
  const depText = (project.dependencies ?? []).map((d) => d.package.toLowerCase()).join(' ');
  if (matchesStem(depText, WEB_DEP_STEMS)) vote('web-app', 1, 'web-dependency');
  if (matchesStem(depText, API_DEP_STEMS)) vote('api', 1, 'api-dependency');

  if (uiPurpose && (uiPurpose.routes?.length || uiPurpose.samples?.length)) {
    vote('web-app', 1, 'ui-evidence');
  }

  // Domain-specific signals from dependency + framework names (language-agnostic).
  const haystack = `${fwText} ${depText}`;
  if (ML_RE.test(haystack)) vote('ml', 2, 'ml-libs');
  if (INFRA_RE.test(haystack)) vote('infra', 2, 'infra-tooling');

  const entries = Object.entries(votes).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) {
    return { project: project.name, category: 'any', confidence: 0.3, signals: ['no-strong-signal'] };
  }
  const [topCategory, topWeight] = entries[0];
  const total = entries.reduce((s, [, w]) => s + w, 0);
  const confidence = Math.min(0.95, 0.4 + (topWeight / total) * 0.55);
  return {
    project: project.name,
    category: topCategory,
    confidence: Number(confidence.toFixed(2)),
    signals: [...new Set(signals)],
  };
}

function appliesToPurpose(entry: StandardIndexEntry, category: string): boolean {
  if (!entry.projectTypes || entry.projectTypes.length === 0) return false;
  return entry.projectTypes.includes('any') || entry.projectTypes.includes(category);
}

/** Categories/domains most relevant to each purpose, used to float the obvious picks up. */
// Ordered most→least relevant; earlier categories get a larger bonus so the
// obvious picks (e.g. OWASP API Top 10, OpenAPI for an API) float above generic
// compliance-relevant standards that merely also apply.
const AFFINITY: Record<string, { categories: string[]; domains: string[] }> = {
  api: { categories: ['security', 'api-spec'], domains: ['api', 'security'] },
  'web-app': { categories: ['security', 'accessibility'], domains: ['security', 'accessibility', 'frontend'] },
  library: { categories: ['software-process', 'programming-language'], domains: ['process', 'language'] },
  cli: { categories: ['software-process'], domains: ['process'] },
  data: { categories: ['database-sql', 'data-format'], domains: ['data'] },
  ml: { categories: ['ai-governance'], domains: ['ai'] },
  infra: { categories: ['devops', 'cloud-architecture'], domains: ['devops', 'cloud'] },
};

/**
 * Rank standards for a purpose category. Affinity (category/domain match to the
 * purpose) floats the obvious picks up; compliance-relevance and a tight
 * (non-'any') project-type match break further ties.
 */
function rankStandardsForCategory(category: string): Array<{ rec: RecommendedStandard; score: number }> {
  const affinity = AFFINITY[category] ?? { categories: [], domains: [] };
  const ranked = standardsIndex
    .filter((e) => appliesToPurpose(e, category))
    .map((e) => {
      const tight = e.projectTypes.includes(category) && !e.projectTypes.includes('any');
      const catIdx = affinity.categories.indexOf(e.category);
      const categoryAffinity = catIdx >= 0 ? (affinity.categories.length - catIdx) * 2 : 0;
      const domainAffinity = e.domains.some((d) => affinity.domains.includes(d)) ? 1 : 0;
      const score = categoryAffinity + domainAffinity + (e.complianceRelevant ? 2 : 0) + (tight ? 1 : 0);
      return { e, score, tight };
    })
    .sort((a, b) => b.score - a.score || a.e.slug.localeCompare(b.e.slug));

  return ranked.map(({ e, score, tight }) => ({
    score,
    rec: {
      slug: e.slug,
      name: e.name,
      category: e.category,
      reason: tight
        ? `Applies specifically to ${category} projects`
        : e.complianceRelevant
          ? 'Compliance-relevant standard applicable to this stack'
          : 'Generally applicable standard',
      matchedProjectTypes: [category],
      frameworks: e.frameworks,
      complianceRelevant: e.complianceRelevant,
      officialUrl: e.officialUrl,
    },
  }));
}

export interface MatcherOptions {
  /** Max recommended standards to retain per purpose category (default 10). */
  perCategoryLimit?: number;
  /** Overall cap on the recommended set (default 40). */
  totalLimit?: number;
}

/**
 * Match a scanned repository (its projects + extended results) onto a recommended
 * set of standards and compliance-framework coverage.
 */
export function recommendStandards(
  projects: ProjectScan[],
  extended?: ExtendedScanResults,
  options: MatcherOptions = {},
): StandardsRecommendations {
  const perCategoryLimit = options.perCategoryLimit ?? 10;
  const totalLimit = options.totalLimit ?? 40;
  // Workspace-level UI frameworks (UiPurposeResult) as a fallback when a project
  // has no per-project CompactUiPurpose of its own.
  const fallbackUi: CompactUiPurpose | undefined = extended?.uiPurpose
    ? {
        samples: [],
        categoryCounts: {},
        originalCount: 0,
        dependencies: [],
        routes: [],
        detectedFrameworks: extended.uiPurpose.detectedFrameworks ?? [],
      }
    : undefined;

  const projectPurposes = projects.map((p) => inferProjectPurpose(p, p.uiPurpose ?? fallbackUi));
  const categories = [...new Set(projectPurposes.map((p) => p.category))];

  // Merge recommendations across all purpose categories present in the repo,
  // keeping the best relevance score seen for each standard.
  const bySlug = new Map<string, RecommendedStandard>();
  const scoreBySlug = new Map<string, number>();
  for (const category of categories) {
    const ranked = rankStandardsForCategory(category).slice(0, perCategoryLimit);
    for (const { rec, score } of ranked) {
      const existing = bySlug.get(rec.slug);
      if (existing) {
        if (!existing.matchedProjectTypes.includes(category)) existing.matchedProjectTypes.push(category);
        scoreBySlug.set(rec.slug, Math.max(scoreBySlug.get(rec.slug) ?? 0, score));
      } else {
        bySlug.set(rec.slug, { ...rec });
        scoreBySlug.set(rec.slug, score);
      }
    }
  }

  const recommended = [...bySlug.values()]
    .sort(
      (a, b) =>
        (scoreBySlug.get(b.slug) ?? 0) - (scoreBySlug.get(a.slug) ?? 0) ||
        b.matchedProjectTypes.length - a.matchedProjectTypes.length ||
        a.slug.localeCompare(b.slug),
    )
    .slice(0, totalLimit);

  const recommendedSlugs = new Set(recommended.map((r) => r.slug));
  const frameworks = complianceFrameworks
    .map((fw) => ({
      id: fw.id,
      name: fw.name,
      recommendedMembers: fw.memberStandards.filter((s) => recommendedSlugs.has(s)).length,
      totalMembers: fw.memberStandards.length,
    }))
    .filter((f) => f.recommendedMembers > 0)
    .sort((a, b) => b.recommendedMembers - a.recommendedMembers);

  return { projectPurposes, recommended, frameworks };
}
