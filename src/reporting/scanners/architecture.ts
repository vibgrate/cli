import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { FileCache } from '../../core-open/index.js';
import type {
  ProjectScan,
  DependencyRow,
  ArchitectureResult,
  ArchitectureLayer,
  LayerSummary,
  LayerClassification,
  LayerPackageRef,
  ProjectArchetype,
  InventoryItem,
  ServiceDependencyItem,
  ToolingInventoryResult,
  ServiceDependenciesResult,
  RiskLevel,
} from '../../core-open/index.js';

// ── Archetype fingerprinting ──

/** Detect project archetype from dependency list */
const ARCHETYPE_SIGNALS: Array<{ packages: string[]; archetype: ProjectArchetype; weight: number }> = [
  // Meta-frameworks (highest priority — they imply routing patterns)
  { packages: ['next', '@next/core'], archetype: 'nextjs', weight: 10 },
  { packages: ['@remix-run/react', '@remix-run/node', '@remix-run/dev'], archetype: 'remix', weight: 10 },
  { packages: ['@sveltejs/kit'], archetype: 'sveltekit', weight: 10 },
  { packages: ['nuxt'], archetype: 'nuxt', weight: 10 },

  // Backend frameworks
  { packages: ['@nestjs/core', '@nestjs/common'], archetype: 'nestjs', weight: 9 },
  { packages: ['fastify'], archetype: 'fastify', weight: 8 },
  { packages: ['hono'], archetype: 'hono', weight: 8 },
  { packages: ['koa'], archetype: 'koa', weight: 8 },
  { packages: ['express'], archetype: 'express', weight: 7 },

  // Serverless
  { packages: ['serverless', 'aws-lambda', '@aws-sdk/client-lambda', 'middy', '@cloudflare/workers-types'], archetype: 'serverless', weight: 6 },

  // CLI
  { packages: ['commander', 'yargs', 'meow', 'cac', 'clipanion', 'oclif'], archetype: 'cli', weight: 5 },
];

function detectArchetype(projects: ProjectScan[]): { archetype: ProjectArchetype; confidence: number } {
  const allPackages = new Set<string>();
  for (const p of projects) {
    for (const d of p.dependencies) {
      allPackages.add(d.package);
    }
  }

  // Check for monorepo first (multiple projects = likely monorepo)
  if (projects.length > 2) {
    return { archetype: 'monorepo', confidence: 0.8 };
  }

  // Score each archetype
  let bestArchetype: ProjectArchetype = 'unknown';
  let bestScore = 0;

  for (const signal of ARCHETYPE_SIGNALS) {
    const matched = signal.packages.filter((p) => allPackages.has(p)).length;
    if (matched > 0) {
      const score = matched * signal.weight;
      if (score > bestScore) {
        bestScore = score;
        bestArchetype = signal.archetype;
      }
    }
  }

  // Check library archetype: has exports/main in package.json but no backend/frontend framework
  if (bestArchetype === 'unknown') {
    // If project has no recognisable framework, it's likely a library
    bestArchetype = 'library';
    bestScore = 3;
  }

  // Confidence is normalised — max possible score for a single match is ~20
  const confidence = Math.min(bestScore / 15, 1);
  return { archetype: bestArchetype, confidence: Math.round(confidence * 100) / 100 };
}

// ── File classification rules ──

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
  { pattern: /\.dto\.[jt]sx?$/, layer: 'domain', confidence: 0.85, signal: 'NestJS DTO', archetypes: ['nestjs'] },
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
  { pattern: /\/hooks\//, layer: 'middleware', confidence: 0.6, signal: 'hooks/ directory' },
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
  { suffix: '.dto', layer: 'domain', confidence: 0.8, signal: 'DTO suffix' },
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

// ── Dependency → layer mapping (which packages indicate which layers) ──

const PACKAGE_LAYER_MAP: Record<string, ArchitectureLayer> = {
  // Routing/controllers
  'express': 'routing',
  'fastify': 'routing',
  '@nestjs/core': 'routing',
  'hono': 'routing',
  'koa': 'routing',
  'koa-router': 'routing',
  '@hapi/hapi': 'routing',
  'h3': 'routing',

  // Middleware
  'cors': 'middleware',
  'helmet': 'middleware',
  'passport': 'middleware',
  'express-rate-limit': 'middleware',
  'cookie-parser': 'middleware',
  'body-parser': 'middleware',
  'multer': 'middleware',
  'morgan': 'middleware',
  'compression': 'middleware',
  'express-session': 'middleware',

  // Services / application
  'bullmq': 'services',
  'bull': 'services',
  'agenda': 'services',
  'pg-boss': 'services',
  'inngest': 'services',

  // Domain / validation
  'zod': 'domain',
  'joi': 'domain',
  'yup': 'domain',
  'class-validator': 'domain',
  'class-transformer': 'domain',
  'superstruct': 'domain',
  'valibot': 'domain',

  // Data access / ORM
  'prisma': 'data-access',
  '@prisma/client': 'data-access',
  'drizzle-orm': 'data-access',
  'typeorm': 'data-access',
  'sequelize': 'data-access',
  'knex': 'data-access',
  'pg': 'data-access',
  'mysql2': 'data-access',
  'mongodb': 'data-access',
  'mongoose': 'data-access',
  'ioredis': 'data-access',
  'redis': 'data-access',
  'better-sqlite3': 'data-access',
  'kysely': 'data-access',
  '@mikro-orm/core': 'data-access',

  // Infrastructure
  '@aws-sdk/client-s3': 'infrastructure',
  '@aws-sdk/client-sqs': 'infrastructure',
  '@aws-sdk/client-sns': 'infrastructure',
  '@aws-sdk/client-ses': 'infrastructure',
  '@aws-sdk/client-lambda': 'infrastructure',
  '@google-cloud/storage': 'infrastructure',
  '@azure/storage-blob': 'infrastructure',
  'nodemailer': 'infrastructure',
  '@sendgrid/mail': 'infrastructure',
  'stripe': 'infrastructure',
  'kafkajs': 'infrastructure',
  'amqplib': 'infrastructure',

  // Presentation
  'react': 'presentation',
  'react-dom': 'presentation',
  'vue': 'presentation',
  '@angular/core': 'presentation',
  'svelte': 'presentation',

  // Shared
  'lodash': 'shared',
  'dayjs': 'shared',
  'date-fns': 'shared',
  'uuid': 'shared',
  'nanoid': 'shared',

  // Testing
  'vitest': 'testing',
  'jest': 'testing',
  'mocha': 'testing',
  '@playwright/test': 'testing',
  'cypress': 'testing',
  'supertest': 'testing',

  // Observability → infrastructure
  '@sentry/node': 'infrastructure',
  '@opentelemetry/api': 'infrastructure',
  'pino': 'infrastructure',
  'winston': 'infrastructure',
  'dd-trace': 'infrastructure',
};

// ── Source file walker ──

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs', '.cts', '.cjs', '.svelte', '.vue']);
const IGNORE_DIRS = new Set(['node_modules', '.git', '.wrangler', 'dist', 'build', '.next', '.nuxt', '.output', '.svelte-kit', 'coverage', '.vibgrate']);

async function walkSourceFiles(rootDir: string, cache?: FileCache): Promise<string[]> {
  if (cache) {
    // Use the cached walk — framework output dirs already excluded
    const entries = await cache.walkDir(rootDir);
    return entries
      .filter((e) => {
        if (!e.isFile) return false;
        // Architecture scanner also skips dotfiles
        const name = path.basename(e.absPath);
        if (name.startsWith('.') && name !== '.') return false;
        const ext = path.extname(name);
        return SOURCE_EXTENSIONS.has(ext);
      })
      .map((e) => e.relPath);
  }

  const files: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.') continue;
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (!IGNORE_DIRS.has(entry.name)) {
          await walk(fullPath);
        }
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name);
        if (SOURCE_EXTENSIONS.has(ext)) {
          files.push(path.relative(rootDir, fullPath));
        }
      }
    }
  }

  await walk(rootDir);
  return files;
}

// ── File classifier ──

function classifyFile(
  filePath: string,
  archetype: ProjectArchetype,
): LayerClassification | null {
  const normalised = filePath.replace(/\\/g, '/');

  // Try path rules first (highest priority — archetype-specific first)
  let bestMatch: { layer: ArchitectureLayer; confidence: number; signal: string } | null = null;

  for (const rule of PATH_RULES) {
    // Skip rules for other archetypes
    if (rule.archetypes && rule.archetypes.length > 0 && !rule.archetypes.includes(archetype)) {
      continue;
    }

    if (rule.pattern.test(normalised)) {
      // Archetype-specific rules get a boost
      const boost = rule.archetypes ? 0.05 : 0;
      const adjustedConfidence = Math.min(rule.confidence + boost, 1);

      if (!bestMatch || adjustedConfidence > bestMatch.confidence) {
        bestMatch = { layer: rule.layer, confidence: adjustedConfidence, signal: rule.signal };
      }
    }
  }

  // Try suffix rules as fallback
  if (!bestMatch || bestMatch.confidence < 0.7) {
    const baseName = path.basename(filePath, path.extname(filePath));
    // Also strip test suffixes
    const cleanBase = baseName.replace(/\.(test|spec)$/, '');

    for (const rule of SUFFIX_RULES) {
      if (cleanBase.endsWith(rule.suffix)) {
        if (!bestMatch || rule.confidence > bestMatch.confidence) {
          bestMatch = { layer: rule.layer, confidence: rule.confidence, signal: rule.signal };
        }
      }
    }
  }

  if (bestMatch) {
    return {
      filePath,
      layer: bestMatch.layer,
      confidence: bestMatch.confidence,
      signals: [bestMatch.signal],
    };
  }

  return null;
}

// ── Per-layer drift scoring ──

function computeLayerDrift(packages: LayerPackageRef[]): { score: number; riskLevel: RiskLevel } {
  if (packages.length === 0) {
    return { score: 0, riskLevel: 'none' };
  }

  let current = 0;
  let oneBehind = 0;
  let twoPlusBehind = 0;
  let unknown = 0;

  for (const pkg of packages) {
    if (pkg.majorsBehind === null) {
      unknown++;
    } else if (pkg.majorsBehind === 0) {
      current++;
    } else if (pkg.majorsBehind === 1) {
      oneBehind++;
    } else {
      twoPlusBehind++;
    }
  }

  const known = current + oneBehind + twoPlusBehind;
  if (known === 0) return { score: 0, riskLevel: 'none' };

  const currentPct = current / known;
  const onePct = oneBehind / known;
  const twoPct = twoPlusBehind / known;

  // Health (higher = fresher), inverted to drift (0 = no drift, 100 = worst).
  const health = Math.round(Math.max(0, Math.min(100, currentPct * 100 - onePct * 10 - twoPct * 40)));
  const score = 100 - health;
  // Drift 100 with known packages means everything is severely outdated → high risk
  const riskLevel: RiskLevel = score <= 30 ? 'low' : score <= 60 ? 'moderate' : 'high';

  return { score, riskLevel };
}

// ── Tooling/service attribution to layers ──

function mapToolingToLayers(
  tooling: ToolingInventoryResult | undefined,
  services: ServiceDependenciesResult | undefined,
  depsByLayer: Map<ArchitectureLayer, Set<string>>,
): {
  layerTooling: Map<ArchitectureLayer, InventoryItem[]>;
  layerServices: Map<ArchitectureLayer, ServiceDependencyItem[]>;
} {
  const layerTooling = new Map<ArchitectureLayer, InventoryItem[]>();
  const layerServices = new Map<ArchitectureLayer, ServiceDependencyItem[]>();

  // Build a quick package→layer lookup from the classified dependency data
  const pkgLayerLookup = new Map<string, ArchitectureLayer>();
  for (const [layer, packages] of depsByLayer) {
    for (const pkg of packages) {
      pkgLayerLookup.set(pkg, layer);
    }
  }

  // Map tooling items
  if (tooling) {
    for (const [, items] of Object.entries(tooling)) {
      for (const item of items as InventoryItem[]) {
        const layer = pkgLayerLookup.get(item.package) ?? PACKAGE_LAYER_MAP[item.package] ?? 'shared';
        if (!layerTooling.has(layer)) layerTooling.set(layer, []);
        // Avoid duplication
        const existing = layerTooling.get(layer)!;
        if (!existing.some((t) => t.package === item.package)) {
          existing.push(item);
        }
      }
    }
  }

  // Map service items
  if (services) {
    for (const [, items] of Object.entries(services)) {
      for (const item of items as ServiceDependencyItem[]) {
        const layer = pkgLayerLookup.get(item.package) ?? PACKAGE_LAYER_MAP[item.package] ?? 'infrastructure';
        if (!layerServices.has(layer)) layerServices.set(layer, []);
        const existing = layerServices.get(layer)!;
        if (!existing.some((s) => s.package === item.package)) {
          existing.push(item);
        }
      }
    }
  }

  return { layerTooling, layerServices };
}


function generateLayerFlowMermaid(layers: ArchitectureLayer[]): string {
  const labels: Record<ArchitectureLayer, string> = {
    presentation: 'Presentation',
    routing: 'Routing',
    middleware: 'Middleware',
    services: 'Services',
    domain: 'Domain',
    'data-access': 'Data Access',
    infrastructure: 'Infrastructure',
    config: 'Config',
    shared: 'Shared',
    testing: 'Testing',
  };

  if (layers.length === 0) {
    return 'flowchart TD\n  APP["Project"]';
  }

  const ordered = [...layers];
  const lines: string[] = ['flowchart TD'];
  for (let i = 0; i < ordered.length; i++) {
    const layer = ordered[i];
    lines.push(`  L${i}["${labels[layer]}"]`);
    if (i > 0) lines.push(`  L${i-1} --> L${i}`);
  }
  return lines.join('\n');
}

export async function buildProjectArchitectureMermaid(
  rootDir: string,
  project: ProjectScan,
  archetype: ProjectArchetype,
  cache?: FileCache,
): Promise<string> {
  const projectRoot = path.resolve(rootDir, project.path || '.');
  const allFiles = await walkSourceFiles(projectRoot, cache);
  const layerSet = new Set<ArchitectureLayer>();

  for (const rel of allFiles) {
    const classification = classifyFile(rel, archetype);
    if (classification) {
      layerSet.add(classification.layer);
    }
  }

  const layerOrder: ArchitectureLayer[] = [
    'presentation', 'routing', 'middleware', 'services', 'domain',
    'data-access', 'infrastructure', 'config', 'shared', 'testing',
  ];
  const orderedLayers = layerOrder.filter((l) => layerSet.has(l));
  return generateLayerFlowMermaid(orderedLayers);
}

/**
 * Run architecture detection scoped to a single project directory.
 * Same logic as scanArchitecture but with rootDir = project directory.
 */
export async function scanProjectArchitecture(
  rootDir: string,
  project: ProjectScan,
  cache?: FileCache,
): Promise<ArchitectureResult> {
  const projectRoot = path.resolve(rootDir, project.path || '.');
  return scanArchitecture(projectRoot, [project], undefined, undefined, cache);
}

/**
 * Aggregate per-project ArchitectureResults into a single solution-level result.
 * Merges layer summaries (summing file counts, merging packages/tech/services),
 * picks the most-confident archetype across member projects.
 */
export function aggregateSolutionArchitecture(
  projectResults: ArchitectureResult[],
): ArchitectureResult {
  if (projectResults.length === 0) {
    return { archetype: 'unknown', archetypeConfidence: 0, layers: [], totalClassified: 0, unclassified: 0 };
  }
  if (projectResults.length === 1) {
    return projectResults[0];
  }

  // Pick the archetype with highest confidence; break ties by favouring non-monorepo
  let bestArchetype: ProjectArchetype = 'unknown';
  let bestConfidence = 0;
  for (const r of projectResults) {
    if (
      r.archetypeConfidence > bestConfidence ||
      (r.archetypeConfidence === bestConfidence && r.archetype !== 'monorepo')
    ) {
      bestArchetype = r.archetype;
      bestConfidence = r.archetypeConfidence;
    }
  }

  // Merge layer summaries
  const layerMap = new Map<ArchitectureLayer, LayerSummary>();
  for (const r of projectResults) {
    for (const ls of r.layers) {
      const existing = layerMap.get(ls.layer);
      if (!existing) {
        layerMap.set(ls.layer, { ...ls, packages: [...ls.packages], techStack: [...ls.techStack], services: [...ls.services] });
      } else {
        existing.fileCount += ls.fileCount;
        // Merge packages (dedup by name)
        const pkgNames = new Set(existing.packages.map((p) => p.name));
        for (const pkg of ls.packages) {
          if (!pkgNames.has(pkg.name)) {
            existing.packages.push(pkg);
            pkgNames.add(pkg.name);
          }
        }
        // Merge tech stack (dedup by package)
        const techPkgs = new Set(existing.techStack.map((t) => t.package));
        for (const t of ls.techStack) {
          if (!techPkgs.has(t.package)) {
            existing.techStack.push(t);
            techPkgs.add(t.package);
          }
        }
        // Merge services (dedup by package)
        const svcPkgs = new Set(existing.services.map((s) => s.package));
        for (const s of ls.services) {
          if (!svcPkgs.has(s.package)) {
            existing.services.push(s);
            svcPkgs.add(s.package);
          }
        }
        // Recompute drift for merged packages
        const { score, riskLevel } = computeLayerDrift(existing.packages);
        existing.driftScore = score;
        existing.riskLevel = riskLevel;
      }
    }
  }

  // Sort layers in architectural order
  const LAYER_ORDER: Record<ArchitectureLayer, number> = {
    'presentation': 0, 'routing': 1, 'middleware': 2, 'services': 3, 'domain': 4,
    'data-access': 5, 'infrastructure': 6, 'config': 7, 'shared': 8, 'testing': 9,
  };
  const layers = [...layerMap.values()].sort((a, b) => (LAYER_ORDER[a.layer] ?? 99) - (LAYER_ORDER[b.layer] ?? 99));

  const totalClassified = projectResults.reduce((s, r) => s + r.totalClassified, 0);
  const unclassified = projectResults.reduce((s, r) => s + r.unclassified, 0);

  return { archetype: bestArchetype, archetypeConfidence: bestConfidence, layers, totalClassified, unclassified };
}

// ── Main scanner entry point ──

export async function scanArchitecture(
  rootDir: string,
  projects: ProjectScan[],
  tooling?: ToolingInventoryResult,
  services?: ServiceDependenciesResult,
  cache?: FileCache,
): Promise<ArchitectureResult> {
  // 1. Detect project archetype
  const { archetype, confidence: archetypeConfidence } = detectArchetype(projects);

  // 2. Walk source files
  const sourceFiles = await walkSourceFiles(rootDir, cache);

  // 3. Classify each file into a layer
  const classifications: LayerClassification[] = [];
  let unclassified = 0;

  for (const file of sourceFiles) {
    const classification = classifyFile(file, archetype);
    if (classification) {
      classifications.push(classification);
    } else {
      unclassified++;
    }
  }

  // 4. Build dependency map: collect all packages used across projects
  const allDeps = new Map<string, DependencyRow>();
  for (const p of projects) {
    for (const d of p.dependencies) {
      if (!allDeps.has(d.package)) {
        allDeps.set(d.package, d);
      }
    }
  }

  // 5. Assign packages to layers using PACKAGE_LAYER_MAP
  const depsByLayer = new Map<ArchitectureLayer, Set<string>>();
  for (const [pkg] of allDeps) {
    const layer = PACKAGE_LAYER_MAP[pkg];
    if (layer) {
      if (!depsByLayer.has(layer)) depsByLayer.set(layer, new Set());
      depsByLayer.get(layer)!.add(pkg);
    }
  }

  // 6. Map tooling and services to layers
  const { layerTooling, layerServices } = mapToolingToLayers(tooling, services, depsByLayer);

  // 7. Aggregate into layer summaries
  const ALL_LAYERS: ArchitectureLayer[] = [
    'routing', 'middleware', 'services', 'domain',
    'data-access', 'infrastructure', 'presentation',
    'config', 'testing', 'shared',
  ];

  const layerFileCounts = new Map<ArchitectureLayer, number>();
  for (const c of classifications) {
    layerFileCounts.set(c.layer, (layerFileCounts.get(c.layer) ?? 0) + 1);
  }

  const layers: LayerSummary[] = [];

  for (const layer of ALL_LAYERS) {
    const fileCount = layerFileCounts.get(layer) ?? 0;
    const layerPkgs = depsByLayer.get(layer) ?? new Set<string>();
    const tech = layerTooling.get(layer) ?? [];
    const svc = layerServices.get(layer) ?? [];

    // Skip layers with no files and no dependencies
    if (fileCount === 0 && layerPkgs.size === 0 && tech.length === 0 && svc.length === 0) {
      continue;
    }

    // Build package refs for this layer
    const packages: LayerPackageRef[] = [];
    for (const pkg of layerPkgs) {
      const dep = allDeps.get(pkg);
      if (dep) {
        packages.push({
          name: dep.package,
          version: dep.resolvedVersion,
          latestStable: dep.latestStable,
          majorsBehind: dep.majorsBehind,
          drift: dep.drift,
        });
      }
    }

    // Compute per-layer drift
    const { score, riskLevel } = computeLayerDrift(packages);

    layers.push({
      layer,
      fileCount,
      driftScore: score,
      riskLevel,
      techStack: tech,
      services: svc,
      packages,
    });
  }

  // Sort layers by architectural order (top → bottom)
  const LAYER_ORDER: Record<ArchitectureLayer, number> = {
    'presentation': 0,
    'routing': 1,
    'middleware': 2,
    'services': 3,
    'domain': 4,
    'data-access': 5,
    'infrastructure': 6,
    'config': 7,
    'shared': 8,
    'testing': 9,
  };

  layers.sort((a, b) => (LAYER_ORDER[a.layer] ?? 99) - (LAYER_ORDER[b.layer] ?? 99));

  return {
    archetype,
    archetypeConfidence,
    layers,
    totalClassified: classifications.length,
    unclassified,
  };
}
