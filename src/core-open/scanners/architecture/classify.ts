// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import * as path from 'node:path';
import type {
  ArchitectureLayer,
  LayerClassification,
  ProjectArchetype,
} from '../../types.js';

/**
 * Path / suffix / Pascal file-layer classifier.
 * Shared by the architecture walk and AST refine so off-sample files
 * keep the same path prior the scan already applied.
 */

/** Path-based classification rules, ordered by specificity */
interface PathRule {
  /** Regex to match against the relative file path */
  pattern: RegExp;
  /** Assigned layer */
  layer: ArchitectureLayer;
  /** Base confidence for this rule */
  confidence: number;
  /** Human-readable signal description */
  signal: string;
  /** Only apply for these archetypes (empty = all) */
  archetypes?: ProjectArchetype[];
}

const PATH_RULES: PathRule[] = [
  // ── Testing (high precision) ──
  { pattern: /\/__tests__\//, layer: 'testing', confidence: 0.95, signal: '__tests__ directory' },
  { pattern: /\.test\.[jt]sx?$/, layer: 'testing', confidence: 0.95, signal: '.test.* file' },
  { pattern: /\.spec\.[jt]sx?$/, layer: 'testing', confidence: 0.95, signal: '.spec.* file' },
  { pattern: /\/test\//, layer: 'testing', confidence: 0.85, signal: 'test/ directory' },
  { pattern: /\/tests\//, layer: 'testing', confidence: 0.85, signal: 'tests/ directory' },
  { pattern: /\/__mocks__\//, layer: 'testing', confidence: 0.9, signal: '__mocks__ directory' },
  { pattern: /\/fixtures\//, layer: 'testing', confidence: 0.8, signal: 'fixtures/ directory' },

  // ── Config/Infrastructure (high precision) ──
  { pattern: /\/config\.[jt]sx?$/, layer: 'config', confidence: 0.85, signal: 'config.* file' },
  { pattern: /\/config\//, layer: 'config', confidence: 0.8, signal: 'config/ directory' },
  { pattern: /\.config\.[jt]sx?$/, layer: 'config', confidence: 0.9, signal: '.config.* file' },
  { pattern: /\/env\.[jt]sx?$/, layer: 'config', confidence: 0.85, signal: 'env.* file' },
  { pattern: /\/bootstrap\.[jt]sx?$/, layer: 'config', confidence: 0.85, signal: 'bootstrap file' },
  { pattern: /\/setup\.[jt]sx?$/, layer: 'config', confidence: 0.8, signal: 'setup file' },

  // ── Next.js (archetype-specific) ──
  { pattern: /(^|\/)app\/.*\/route\.[jt]sx?$/, layer: 'routing', confidence: 0.95, signal: 'Next.js App Router route', archetypes: ['nextjs'] },
  { pattern: /(^|\/)pages\/api\//, layer: 'routing', confidence: 0.95, signal: 'Next.js Pages API route', archetypes: ['nextjs'] },
  { pattern: /(^|\/)app\/.*page\.[jt]sx?$/, layer: 'presentation', confidence: 0.9, signal: 'Next.js page component', archetypes: ['nextjs'] },
  { pattern: /(^|\/)app\/.*layout\.[jt]sx?$/, layer: 'presentation', confidence: 0.9, signal: 'Next.js layout component', archetypes: ['nextjs'] },
  { pattern: /(^|\/)app\/.*loading\.[jt]sx?$/, layer: 'presentation', confidence: 0.85, signal: 'Next.js loading component', archetypes: ['nextjs'] },
  { pattern: /(^|\/)app\/.*error\.[jt]sx?$/, layer: 'presentation', confidence: 0.85, signal: 'Next.js error component', archetypes: ['nextjs'] },
  { pattern: /(^|\/)middleware\.[jt]sx?$/, layer: 'middleware', confidence: 0.9, signal: 'Next.js middleware', archetypes: ['nextjs'] },

  // ── Remix (archetype-specific) ──
  { pattern: /\/app\/routes\//, layer: 'routing', confidence: 0.95, signal: 'Remix route file', archetypes: ['remix'] },
  { pattern: /\/app\/root\.[jt]sx?$/, layer: 'presentation', confidence: 0.9, signal: 'Remix root', archetypes: ['remix'] },

  // ── SvelteKit (archetype-specific) ──
  { pattern: /\/src\/routes\/.*\+server\.[jt]s$/, layer: 'routing', confidence: 0.95, signal: 'SvelteKit API route', archetypes: ['sveltekit'] },
  { pattern: /\/src\/routes\/.*\+page\.svelte$/, layer: 'presentation', confidence: 0.9, signal: 'SvelteKit page', archetypes: ['sveltekit'] },
  { pattern: /\/src\/routes\/.*\+layout\.svelte$/, layer: 'presentation', confidence: 0.9, signal: 'SvelteKit layout', archetypes: ['sveltekit'] },
  { pattern: /\/src\/hooks\.server\.[jt]s$/, layer: 'middleware', confidence: 0.9, signal: 'SvelteKit server hooks', archetypes: ['sveltekit'] },

  // ── Nuxt (archetype-specific) ──
  { pattern: /\/server\/api\//, layer: 'routing', confidence: 0.95, signal: 'Nuxt server API', archetypes: ['nuxt'] },
  { pattern: /\/server\/routes\//, layer: 'routing', confidence: 0.95, signal: 'Nuxt server route', archetypes: ['nuxt'] },
  { pattern: /\/server\/middleware\//, layer: 'middleware', confidence: 0.95, signal: 'Nuxt server middleware', archetypes: ['nuxt'] },
  { pattern: /\/pages\//, layer: 'presentation', confidence: 0.85, signal: 'Nuxt pages directory', archetypes: ['nuxt'] },

  // ── NestJS (archetype-specific) ──
  { pattern: /\.controller\.[jt]sx?$/, layer: 'routing', confidence: 0.95, signal: 'NestJS controller', archetypes: ['nestjs'] },
  { pattern: /\.service\.[jt]sx?$/, layer: 'services', confidence: 0.95, signal: 'NestJS service', archetypes: ['nestjs'] },
  { pattern: /\.module\.[jt]sx?$/, layer: 'config', confidence: 0.9, signal: 'NestJS module', archetypes: ['nestjs'] },
  { pattern: /\.guard\.[jt]sx?$/, layer: 'middleware', confidence: 0.9, signal: 'NestJS guard', archetypes: ['nestjs'] },
  { pattern: /\.interceptor\.[jt]sx?$/, layer: 'middleware', confidence: 0.9, signal: 'NestJS interceptor', archetypes: ['nestjs'] },
  { pattern: /\.pipe\.[jt]sx?$/, layer: 'middleware', confidence: 0.85, signal: 'NestJS pipe', archetypes: ['nestjs'] },
  { pattern: /\.middleware\.[jt]sx?$/, layer: 'middleware', confidence: 0.9, signal: 'NestJS middleware', archetypes: ['nestjs'] },
  { pattern: /\.entity\.[jt]sx?$/, layer: 'domain', confidence: 0.9, signal: 'NestJS entity', archetypes: ['nestjs'] },
  { pattern: /\.dto\.[jt]sx?$/, layer: 'services', confidence: 0.85, signal: 'NestJS DTO', archetypes: ['nestjs'] },
  { pattern: /\.repository\.[jt]sx?$/, layer: 'data-access', confidence: 0.9, signal: 'NestJS repository', archetypes: ['nestjs'] },

  // ── Generic routing patterns ──
  { pattern: /\/routes\//, layer: 'routing', confidence: 0.8, signal: 'routes/ directory' },
  { pattern: /\/router\//, layer: 'routing', confidence: 0.8, signal: 'router/ directory' },
  { pattern: /\/controllers\//, layer: 'routing', confidence: 0.8, signal: 'controllers/ directory' },
  { pattern: /\/handlers\//, layer: 'routing', confidence: 0.75, signal: 'handlers/ directory' },
  { pattern: /\/api\//, layer: 'routing', confidence: 0.7, signal: 'api/ directory' },
  { pattern: /\/endpoints\//, layer: 'routing', confidence: 0.8, signal: 'endpoints/ directory' },

  // ── Middleware ──
  { pattern: /\/middleware\//, layer: 'middleware', confidence: 0.85, signal: 'middleware/ directory' },
  { pattern: /\/middlewares\//, layer: 'middleware', confidence: 0.85, signal: 'middlewares/ directory' },
  { pattern: /\/hooks\//, layer: 'presentation', confidence: 0.75, signal: 'hooks/ directory (UI)' },
  { pattern: /\/plugins\//, layer: 'middleware', confidence: 0.6, signal: 'plugins/ directory' },
  { pattern: /\/guards\//, layer: 'middleware', confidence: 0.85, signal: 'guards/ directory' },
  { pattern: /\/interceptors\//, layer: 'middleware', confidence: 0.85, signal: 'interceptors/ directory' },

  // ── Services / application layer ──
  { pattern: /\/services\//, layer: 'services', confidence: 0.85, signal: 'services/ directory' },
  { pattern: /\/service\//, layer: 'services', confidence: 0.8, signal: 'service/ directory' },
  { pattern: /\/usecases\//, layer: 'services', confidence: 0.85, signal: 'usecases/ directory' },
  { pattern: /\/use-cases\//, layer: 'services', confidence: 0.85, signal: 'use-cases/ directory' },
  { pattern: /\/application\//, layer: 'services', confidence: 0.7, signal: 'application/ directory' },
  { pattern: /\/actions\//, layer: 'services', confidence: 0.65, signal: 'actions/ directory' },

  // ── Domain / models ──
  { pattern: /\/domain\//, layer: 'domain', confidence: 0.85, signal: 'domain/ directory' },
  { pattern: /\/models\//, layer: 'domain', confidence: 0.8, signal: 'models/ directory' },
  { pattern: /\/entities\//, layer: 'domain', confidence: 0.85, signal: 'entities/ directory' },
  { pattern: /\/types\//, layer: 'domain', confidence: 0.7, signal: 'types/ directory' },
  { pattern: /\/schemas\//, layer: 'domain', confidence: 0.7, signal: 'schemas/ directory' },
  { pattern: /\/validators\//, layer: 'domain', confidence: 0.7, signal: 'validators/ directory' },

  // ── Data access ──
  { pattern: /\/repositories\//, layer: 'data-access', confidence: 0.9, signal: 'repositories/ directory' },
  { pattern: /\/repository\//, layer: 'data-access', confidence: 0.85, signal: 'repository/ directory' },
  { pattern: /\/dao\//, layer: 'data-access', confidence: 0.9, signal: 'dao/ directory' },
  { pattern: /\/db\//, layer: 'data-access', confidence: 0.8, signal: 'db/ directory' },
  { pattern: /\/database\//, layer: 'data-access', confidence: 0.8, signal: 'database/ directory' },
  { pattern: /\/persistence\//, layer: 'data-access', confidence: 0.85, signal: 'persistence/ directory' },
  { pattern: /\/migrations\//, layer: 'data-access', confidence: 0.9, signal: 'migrations/ directory' },
  { pattern: /\/seeds\//, layer: 'data-access', confidence: 0.85, signal: 'seeds/ directory' },
  { pattern: /\/prisma\//, layer: 'data-access', confidence: 0.85, signal: 'prisma/ directory' },
  { pattern: /\/drizzle\//, layer: 'data-access', confidence: 0.85, signal: 'drizzle/ directory' },

  // ── Infrastructure ──
  { pattern: /\/infra\//, layer: 'infrastructure', confidence: 0.85, signal: 'infra/ directory' },
  { pattern: /\/infrastructure\//, layer: 'infrastructure', confidence: 0.85, signal: 'infrastructure/ directory' },
  { pattern: /\/adapters\//, layer: 'infrastructure', confidence: 0.8, signal: 'adapters/ directory' },
  { pattern: /\/clients\//, layer: 'infrastructure', confidence: 0.75, signal: 'clients/ directory' },
  { pattern: /\/integrations\//, layer: 'infrastructure', confidence: 0.8, signal: 'integrations/ directory' },
  { pattern: /\/external\//, layer: 'infrastructure', confidence: 0.75, signal: 'external/ directory' },
  { pattern: /\/queue\//, layer: 'infrastructure', confidence: 0.8, signal: 'queue/ directory' },
  { pattern: /\/jobs\//, layer: 'infrastructure', confidence: 0.75, signal: 'jobs/ directory' },
  { pattern: /\/workers\//, layer: 'infrastructure', confidence: 0.75, signal: 'workers/ directory' },
  { pattern: /\/cron\//, layer: 'infrastructure', confidence: 0.8, signal: 'cron/ directory' },

  // ── Presentation (UI layer) ──
  { pattern: /\/components\//, layer: 'presentation', confidence: 0.85, signal: 'components/ directory' },
  { pattern: /\/views\//, layer: 'presentation', confidence: 0.85, signal: 'views/ directory' },
  { pattern: /\/pages\//, layer: 'presentation', confidence: 0.8, signal: 'pages/ directory' },
  { pattern: /\/layouts\//, layer: 'presentation', confidence: 0.85, signal: 'layouts/ directory' },
  { pattern: /\/templates\//, layer: 'presentation', confidence: 0.8, signal: 'templates/ directory' },
  { pattern: /\/widgets\//, layer: 'presentation', confidence: 0.8, signal: 'widgets/ directory' },
  { pattern: /\/ui\//, layer: 'presentation', confidence: 0.75, signal: 'ui/ directory' },

  // ── Shared / utils ──
  { pattern: /\/utils\//, layer: 'shared', confidence: 0.7, signal: 'utils/ directory' },
  { pattern: /\/helpers\//, layer: 'shared', confidence: 0.7, signal: 'helpers/ directory' },
  { pattern: /\/lib\//, layer: 'shared', confidence: 0.6, signal: 'lib/ directory' },
  { pattern: /\/common\//, layer: 'shared', confidence: 0.65, signal: 'common/ directory' },
  { pattern: /\/shared\//, layer: 'shared', confidence: 0.75, signal: 'shared/ directory' },
  { pattern: /\/constants\//, layer: 'shared', confidence: 0.7, signal: 'constants/ directory' },

  // ── CLI-specific (command layer → routing) ──
  { pattern: /\/commands\//, layer: 'routing', confidence: 0.8, signal: 'commands/ directory', archetypes: ['cli'] },
  { pattern: /\/formatters\//, layer: 'presentation', confidence: 0.8, signal: 'formatters/ directory', archetypes: ['cli'] },
  { pattern: /\/scanners\//, layer: 'services', confidence: 0.8, signal: 'scanners/ directory', archetypes: ['cli'] },
  { pattern: /\/scoring\//, layer: 'domain', confidence: 0.8, signal: 'scoring/ directory', archetypes: ['cli'] },

  // ── Serverless-specific ──
  { pattern: /\/functions\//, layer: 'routing', confidence: 0.8, signal: 'functions/ directory', archetypes: ['serverless'] },
  { pattern: /\/lambdas\//, layer: 'routing', confidence: 0.85, signal: 'lambdas/ directory', archetypes: ['serverless'] },
  { pattern: /\/layers\//, layer: 'shared', confidence: 0.7, signal: 'Lambda layers/ directory', archetypes: ['serverless'] },

  // ── .NET conventions ──
  // Directory rules above already cover Controllers/, Services/, Models/,
  // Views/, Migrations/, Middleware/ … because matching is case-insensitive.
  { pattern: /\.tests?\//, layer: 'testing', confidence: 0.9, signal: '*.Tests project directory' },
  // Layer-named project directories (`Company.Product.Domain/`,
  // `Company.Product.Database/`) — the dotted segment carries the layer.
  { pattern: /\.domain\//, layer: 'domain', confidence: 0.85, signal: '*.Domain project' },
  { pattern: /\.(database|data|persistence)\//, layer: 'data-access', confidence: 0.85, signal: '*.Database project' },
  { pattern: /\.(infrastructure|infra)\//, layer: 'infrastructure', confidence: 0.85, signal: '*.Infrastructure project' },
  { pattern: /\.worker\//, layer: 'infrastructure', confidence: 0.8, signal: '*.Worker project' },
  { pattern: /\.(webapi|api)\//, layer: 'routing', confidence: 0.8, signal: '*.WebApi project' },
  { pattern: /\.(webapp|web|ui)\//, layer: 'presentation', confidence: 0.75, signal: '*.WebApp project' },
  { pattern: /\.(services?|application)\//, layer: 'services', confidence: 0.8, signal: '*.Services project' },
  { pattern: /\/wwwroot\//, layer: 'presentation', confidence: 0.85, signal: 'wwwroot/ static assets' },
  { pattern: /\/properties\//, layer: 'config', confidence: 0.85, signal: 'Properties/ directory' },
  { pattern: /\/program\.cs$/, layer: 'config', confidence: 0.9, signal: 'Program.cs entry point' },
  { pattern: /\/startup\.cs$/, layer: 'config', confidence: 0.9, signal: 'Startup.cs' },
  { pattern: /\.(cshtml|razor)$/, layer: 'presentation', confidence: 0.9, signal: 'Razor view' },

  // ── JVM (Maven/Gradle standard layout + Spring package conventions) ──
  { pattern: /\/src\/(test|androidtest|integrationtest)\//, layer: 'testing', confidence: 0.95, signal: 'src/test source set' },
  { pattern: /\/controller\//, layer: 'routing', confidence: 0.8, signal: 'controller/ package' },
  { pattern: /\/resource\//, layer: 'routing', confidence: 0.7, signal: 'resource/ package (JAX-RS)' },
  { pattern: /\/model\//, layer: 'domain', confidence: 0.75, signal: 'model/ package' },
  { pattern: /\/entity\//, layer: 'domain', confidence: 0.85, signal: 'entity/ package' },
  { pattern: /\/dto\//, layer: 'services', confidence: 0.85, signal: 'dto/ package' },
  { pattern: /\/mappers?\//, layer: 'data-access', confidence: 0.75, signal: 'mapper/ package' },

  // ── Python (Django/Flask/FastAPI module conventions) ──
  { pattern: /\/(test_[^/]*|conftest)\.py$/, layer: 'testing', confidence: 0.95, signal: 'pytest test module' },
  { pattern: /\/urls\.py$/, layer: 'routing', confidence: 0.95, signal: 'Django urls.py' },
  { pattern: /\/views\.py$/, layer: 'routing', confidence: 0.9, signal: 'Django views.py (request handlers)' },
  { pattern: /\/models\.py$/, layer: 'domain', confidence: 0.9, signal: 'Django models.py' },
  { pattern: /\/serializers\.py$/, layer: 'domain', confidence: 0.85, signal: 'DRF serializers.py' },
  { pattern: /\/forms\.py$/, layer: 'presentation', confidence: 0.8, signal: 'Django forms.py' },
  { pattern: /\/(settings|admin)\.py$/, layer: 'config', confidence: 0.85, signal: 'Django settings/admin module' },
  { pattern: /\/middleware\.py$/, layer: 'middleware', confidence: 0.9, signal: 'middleware.py' },
  { pattern: /\/(tasks|celery)\.py$/, layer: 'services', confidence: 0.8, signal: 'task queue module' },

  // ── Go / Rust / Dart / Ruby / Elixir test conventions ──
  { pattern: /_(test|spec)\.[a-z]+$/, layer: 'testing', confidence: 0.95, signal: '_test/_spec file' },
  { pattern: /\/spec\//, layer: 'testing', confidence: 0.85, signal: 'spec/ directory (RSpec)' },
  { pattern: /\/cmd\//, layer: 'routing', confidence: 0.7, signal: 'cmd/ entry points (Go)' },

  // ── Ruby on Rails ──
  { pattern: /\/migrate\//, layer: 'data-access', confidence: 0.9, signal: 'db/migrate/ directory' },
  { pattern: /\/mailers\//, layer: 'infrastructure', confidence: 0.8, signal: 'mailers/ directory' },
  { pattern: /\.erb$/, layer: 'presentation', confidence: 0.85, signal: 'ERB view template' },

  // ── PHP (Laravel/Symfony) ──
  { pattern: /\.blade\.php$/, layer: 'presentation', confidence: 0.9, signal: 'Blade view template' },

  // ── Elixir (Phoenix) ──
  { pattern: /\/channels\//, layer: 'routing', confidence: 0.7, signal: 'channels/ directory' },
  { pattern: /_controller\.exs?$/, layer: 'routing', confidence: 0.9, signal: 'Phoenix controller' },
  { pattern: /_(view|live|html|component)\.exs?$/, layer: 'presentation', confidence: 0.85, signal: 'Phoenix view module' },
  { pattern: /\/repo\.exs?$/, layer: 'data-access', confidence: 0.9, signal: 'Ecto repo' },
  { pattern: /\.(eex|heex)$/, layer: 'presentation', confidence: 0.85, signal: 'EEx/HEEx template' },

  // ── Flutter / mobile ──
  { pattern: /\/screens\//, layer: 'presentation', confidence: 0.85, signal: 'screens/ directory' },
];

// ── File name suffix classification (lower-priority fallback) ──

const SUFFIX_RULES: Array<{ suffix: string; layer: ArchitectureLayer; confidence: number; signal: string }> = [
  { suffix: '.controller', layer: 'routing', confidence: 0.85, signal: 'controller suffix' },
  { suffix: '.route', layer: 'routing', confidence: 0.85, signal: 'route suffix' },
  { suffix: '.router', layer: 'routing', confidence: 0.85, signal: 'router suffix' },
  { suffix: '.handler', layer: 'routing', confidence: 0.8, signal: 'handler suffix' },
  { suffix: '.middleware', layer: 'middleware', confidence: 0.85, signal: 'middleware suffix' },
  { suffix: '.guard', layer: 'middleware', confidence: 0.85, signal: 'guard suffix' },
  { suffix: '.interceptor', layer: 'middleware', confidence: 0.85, signal: 'interceptor suffix' },
  { suffix: '.service', layer: 'services', confidence: 0.85, signal: 'service suffix' },
  { suffix: '.usecase', layer: 'services', confidence: 0.85, signal: 'usecase suffix' },
  { suffix: '.model', layer: 'domain', confidence: 0.8, signal: 'model suffix' },
  { suffix: '.entity', layer: 'domain', confidence: 0.85, signal: 'entity suffix' },
  { suffix: '.dto', layer: 'services', confidence: 0.85, signal: 'DTO suffix' },
  { suffix: '.request', layer: 'services', confidence: 0.85, signal: 'request DTO suffix' },
  { suffix: '.response', layer: 'services', confidence: 0.85, signal: 'response DTO suffix' },
  { suffix: '.schema', layer: 'domain', confidence: 0.75, signal: 'schema suffix' },
  { suffix: '.validator', layer: 'domain', confidence: 0.75, signal: 'validator suffix' },
  { suffix: '.repository', layer: 'data-access', confidence: 0.9, signal: 'repository suffix' },
  { suffix: '.repo', layer: 'data-access', confidence: 0.85, signal: 'repo suffix' },
  { suffix: '.dao', layer: 'data-access', confidence: 0.9, signal: 'dao suffix' },
  { suffix: '.migration', layer: 'data-access', confidence: 0.85, signal: 'migration suffix' },
  { suffix: '.adapter', layer: 'infrastructure', confidence: 0.8, signal: 'adapter suffix' },
  { suffix: '.client', layer: 'infrastructure', confidence: 0.75, signal: 'client suffix' },
  { suffix: '.provider', layer: 'infrastructure', confidence: 0.7, signal: 'provider suffix' },
  { suffix: '.config', layer: 'config', confidence: 0.8, signal: 'config suffix' },
  { suffix: '.component', layer: 'presentation', confidence: 0.8, signal: 'component suffix' },
  { suffix: '.page', layer: 'presentation', confidence: 0.85, signal: 'page suffix' },
  { suffix: '.view', layer: 'presentation', confidence: 0.8, signal: 'view suffix' },
  { suffix: '.layout', layer: 'presentation', confidence: 0.85, signal: 'layout suffix' },
  { suffix: '.util', layer: 'shared', confidence: 0.7, signal: 'util suffix' },
  { suffix: '.helper', layer: 'shared', confidence: 0.7, signal: 'helper suffix' },
  { suffix: '.constant', layer: 'shared', confidence: 0.7, signal: 'constant suffix' },
];

/**
 * PascalCase class-name suffixes — the .NET/Java convention (`UsersController.cs`,
 * `OrderRepository.cs`) where the dot-suffix rules above are the JS/TS one.
 * Matched case-sensitively so `usercontroller.ts` style names don't false-hit.
 */
const PASCAL_SUFFIX_RULES: Array<{ suffix: string; layer: ArchitectureLayer; confidence: number; signal: string }> = [
  { suffix: 'Controller', layer: 'routing', confidence: 0.9, signal: 'Controller class' },
  { suffix: 'Endpoint', layer: 'routing', confidence: 0.85, signal: 'Endpoint class' },
  { suffix: 'Middleware', layer: 'middleware', confidence: 0.9, signal: 'Middleware class' },
  { suffix: 'Filter', layer: 'middleware', confidence: 0.75, signal: 'Filter class' },
  { suffix: 'Service', layer: 'services', confidence: 0.85, signal: 'Service class' },
  { suffix: 'Handler', layer: 'services', confidence: 0.75, signal: 'Handler class' },
  { suffix: 'UseCase', layer: 'services', confidence: 0.85, signal: 'UseCase class' },
  { suffix: 'Entity', layer: 'domain', confidence: 0.85, signal: 'Entity class' },
  { suffix: 'Dto', layer: 'services', confidence: 0.85, signal: 'DTO class' },
  { suffix: 'DTO', layer: 'services', confidence: 0.85, signal: 'DTO class' },
  { suffix: 'Request', layer: 'services', confidence: 0.85, signal: 'request DTO class' },
  { suffix: 'Response', layer: 'services', confidence: 0.85, signal: 'response DTO class' },
  { suffix: 'Command', layer: 'services', confidence: 0.8, signal: 'Command class' },
  { suffix: 'Query', layer: 'services', confidence: 0.8, signal: 'Query class' },
  { suffix: 'Validator', layer: 'domain', confidence: 0.75, signal: 'Validator class' },
  { suffix: 'ViewModel', layer: 'presentation', confidence: 0.85, signal: 'ViewModel class' },
  { suffix: 'Repository', layer: 'data-access', confidence: 0.9, signal: 'Repository class' },
  { suffix: 'DbContext', layer: 'data-access', confidence: 0.95, signal: 'EF Core DbContext' },
  { suffix: 'Migration', layer: 'data-access', confidence: 0.85, signal: 'Migration class' },
  { suffix: 'Client', layer: 'infrastructure', confidence: 0.7, signal: 'Client class' },
  { suffix: 'Tests', layer: 'testing', confidence: 0.95, signal: 'Tests class' },
  { suffix: 'Test', layer: 'testing', confidence: 0.9, signal: 'Test class' },
  // JVM (Spring/JEE/Android)
  { suffix: 'ServiceImpl', layer: 'services', confidence: 0.9, signal: 'ServiceImpl class' },
  { suffix: 'Dao', layer: 'data-access', confidence: 0.9, signal: 'DAO class' },
  { suffix: 'Mapper', layer: 'data-access', confidence: 0.75, signal: 'Mapper class' },
  { suffix: 'Resource', layer: 'routing', confidence: 0.75, signal: 'JAX-RS resource class' },
  { suffix: 'Configuration', layer: 'config', confidence: 0.85, signal: 'Configuration class' },
  { suffix: 'Config', layer: 'config', confidence: 0.8, signal: 'Config class' },
  { suffix: 'Interceptor', layer: 'middleware', confidence: 0.85, signal: 'Interceptor class' },
  { suffix: 'Activity', layer: 'presentation', confidence: 0.85, signal: 'Android Activity' },
  { suffix: 'Fragment', layer: 'presentation', confidence: 0.85, signal: 'Android Fragment' },
  // Swift / iOS — higher confidence than the generic Controller→routing rule
  // so FooViewController lands in presentation, not routing.
  { suffix: 'ViewController', layer: 'presentation', confidence: 0.95, signal: 'UIKit ViewController' },
  // Flutter
  { suffix: 'Screen', layer: 'presentation', confidence: 0.85, signal: 'Screen widget' },
  { suffix: 'Widget', layer: 'presentation', confidence: 0.75, signal: 'Widget class' },
];

// ── File classifier ──

const UI_SOURCE_EXTENSIONS = new Set(['.tsx', '.jsx', '.vue', '.svelte']);

/** Domain port: `IOrderRepository` living under Domain/ or Interfaces/. */
function isDomainRepositoryPort(baseName: string, loweredPath: string): boolean {
  if (!/^I[A-Z]\w*(Repository|Repo)$/.test(baseName)) return false;
  return /\/(domain|interfaces)\//.test(loweredPath);
}

function classifyOne(
  filePath: string,
  archetype: ProjectArchetype,
): { layer: ArchitectureLayer; confidence: number; signal: string } | null {
  // Leading `/` so `/dir/` patterns also match a top-level directory
  // (`tests/Foo.Tests/Bar.cs`); lowercased so PascalCase conventions
  // (.NET `Controllers/`, `Views/`…) hit the same rules as JS lowercase dirs.
  const normalised = '/' + filePath.replace(/\\/g, '/').replace(/^\/+/, '');
  const lowered = normalised.toLowerCase();

  // Fuse path / suffix / Pascal evidence. Stronger file-level signal wins
  // (UsersController.cs under Domain/ is routing, not domain).
  let bestMatch: { layer: ArchitectureLayer; confidence: number; signal: string } | null = null;

  for (const rule of PATH_RULES) {
    // Skip rules for other archetypes
    if (rule.archetypes && rule.archetypes.length > 0 && !rule.archetypes.includes(archetype)) {
      continue;
    }

    if (rule.pattern.test(lowered)) {
      // Archetype-specific rules get a boost
      const boost = rule.archetypes ? 0.05 : 0;
      const adjustedConfidence = Math.min(rule.confidence + boost, 1);

      if (!bestMatch || adjustedConfidence > bestMatch.confidence) {
        bestMatch = { layer: rule.layer, confidence: adjustedConfidence, signal: rule.signal };
      }
    }
  }

  const baseName = path.basename(filePath, path.extname(filePath));
  const cleanBase = baseName.replace(/\.(test|spec)$/, '');

  for (const rule of SUFFIX_RULES) {
    if (cleanBase.endsWith(rule.suffix)) {
      if (!bestMatch || rule.confidence > bestMatch.confidence) {
        bestMatch = { layer: rule.layer, confidence: rule.confidence, signal: rule.signal };
      }
    }
  }

  for (const rule of PASCAL_SUFFIX_RULES) {
    if (cleanBase.endsWith(rule.suffix)) {
      if (!bestMatch || rule.confidence > bestMatch.confidence) {
        bestMatch = { layer: rule.layer, confidence: rule.confidence, signal: rule.signal };
      }
    }
  }

  if (isDomainRepositoryPort(cleanBase, lowered)) {
    const port = { layer: 'domain' as const, confidence: 0.93, signal: 'domain repository port' };
    if (!bestMatch || port.confidence >= bestMatch.confidence || bestMatch.layer === 'data-access') {
      bestMatch = port;
    }
  }

  // Filename suffixes like Controller / Request / Dto lose to a domain folder
  // (`model/ApiGatewayController.java` is an entity, not a route).
  if (
    bestMatch
    && (bestMatch.layer === 'routing' || bestMatch.layer === 'services')
    && /\/(model|entity|entities)\//.test(lowered)
    && /(Controller|Request|Response|Dto|DTO)$/.test(cleanBase)
  ) {
    bestMatch = { layer: 'domain', confidence: 0.88, signal: 'entity folder beats type suffix' };
  }

  if (!bestMatch) {
    const ext = path.extname(filePath).toLowerCase();
    if (UI_SOURCE_EXTENSIONS.has(ext)) {
      bestMatch = { layer: 'presentation', confidence: 0.62, signal: 'ui source extension' };
    }
  }

  return bestMatch;
}

export interface ClassifyFileOptions {
  /**
   * Repo-relative path. When the walk is project-scoped the local path
   * drops the project folder (`src/Application/…` → `Products/Commands/…`).
   * That folder often *is* the layer signal — use it as a hint, not a
   * blanket stamp: a stronger local match still wins.
   */
  repoRelative?: string;
}

/**
 * Only these path segments, when stripped by project scoping, are safe
 * layer hints. `api` / `ui` / `web` are product names, not layers — the
 * scan must not stamp every file in `packages/api` as routing.
 */
const LAYER_HINT_SEGMENT = /(?:^|\/)(application|domain|infrastructure|persistence|entities)(?:\/|$)/i;

function prefixHasLayerHint(repoRelative: string, localPath: string): boolean {
  const repo = repoRelative.replace(/\\/g, '/').replace(/^\/+/, '');
  const local = localPath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!repo.endsWith(local)) return false;
  const prefix = repo.slice(0, repo.length - local.length).replace(/\/+$/, '');
  return prefix.length > 0 && LAYER_HINT_SEGMENT.test(`/${prefix}/`);
}

export function classifyFile(
  filePath: string,
  archetype: ProjectArchetype,
  opts?: ClassifyFileOptions,
): LayerClassification | null {
  const local = classifyOne(filePath, archetype);
  const repoPath = opts?.repoRelative?.replace(/\\/g, '/');
  const repo = repoPath
    && repoPath !== filePath.replace(/\\/g, '/')
    && prefixHasLayerHint(repoPath, filePath)
    ? classifyOne(repoPath, archetype)
    : null;

  let best = local;
  let usedHint = false;
  if (repo && (!local || repo.confidence > local.confidence)) {
    best = repo;
    usedHint = true;
  }

  if (!best) return null;
  return {
    filePath,
    layer: best.layer,
    confidence: best.confidence,
    signals: usedHint ? [best.signal, 'project-path-hint'] : [best.signal],
  };
}
