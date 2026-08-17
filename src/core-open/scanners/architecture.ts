// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { FileCache, isSkippedDirName } from '../utils/fs.js';
import type {
  ProjectScan,
  ProjectType,
  DependencyRow,
  ArchitectureResult,
  ArchitectureLayer,
  ArchitectureEvidence,
  ArchitectureSupportLevel,
  ArchitectureWorkspaceEdge,
  ArchitectureViolation,
  LayerSummary,
  LayerClassification,
  FolderClassification,
  LayerPackageRef,
  ProjectArchetype,
  InventoryItem,
  ServiceDependencyItem,
  ToolingInventoryResult,
  ServiceDependenciesResult,
  RiskLevel,
  WorkspaceShape,
} from '../types.js';
import { ARCHITECTURE_PACKS, UNCLASSIFIED_BY_DESIGN } from './architecture/registry.js';
import {
  collectWalkExtensions,
  FROZEN_SOURCE_EXTENSIONS,
  isBuildBasename,
  isContractBasename,
  isContractOrIacFile,
  contractKindFromName,
} from './architecture/walker.js';
import { collectPackEvidence, fuseEvidence, capEvidence, capWorkspaceEdges, capViolations } from './architecture/fusion.js';
import {
  applyFolderInheritance,
  capUnclassifiedFiles,
  mergeFolderClassifications,
  mergeUnclassifiedFiles,
} from './architecture/folders.js';
import { detectLocalContractEdges, detectWorkspaceEdges } from './architecture/workspace-edges.js';
import { detectGeneratedMeta } from './architecture/packs/artifacts.js';
import type { FusionResult, ProjectContext } from './architecture/types.js';
import {
  generateLayerFlowMermaid,
  LAYER_FLOW_ORDER,
} from './architecture/mermaid.js';
import { classifyFile } from './architecture/classify.js';

export {
  FROZEN_SOURCE_EXTENSIONS,
  collectWalkExtensions,
  UNCLASSIFIED_BY_DESIGN,
  ARCHITECTURE_PACKS,
};
export { fuseEvidence, capEvidence, capViolations, EVIDENCE_PAYLOAD_CAP, EVIDENCE_FLOOR, VIOLATIONS_CAP } from './architecture/fusion.js';
export {
  applyFolderInheritance,
  capUnclassifiedFiles,
  UNCLASSIFIED_FILES_CAP,
  FOLDER_LAYER_MIN_SHARE,
  FOLDER_LAYER_MIN_COUNT,
  FOLDER_INHERIT_MIN_CONFIDENCE,
  folderConflictSignal,
} from './architecture/folders.js';
export { PACKED_PROJECT_TYPES, isProjectTypeCovered } from './architecture/registry.js';
export {
  refineArchitectureWithGraph,
  refineArchitectureResult,
  type ArchitectureGraphView,
  type ArchitectureGraphNode,
  type ArchitectureGraphEdge,
} from './architecture/graph-refine.js';
export {
  applyAstRoles,
  refineArchitectureWithAstRoles,
  matchAstRolesFromSource,
  pickBestHits,
  queriesForLanguage,
  AST_ROLE_CATALOG,
  CLASSIFIED_ROLE_CAP,
  AST_ROLE_SIGNAL_PREFIX,
  AST_CONFIRM_SIGNAL_PREFIX,
  AST_CONFLICT_SIGNAL_PREFIX,
  type AstRoleHit,
} from './architecture/ast-roles.js';
export { mermaidFromArchitecture, LAYER_FLOW_ORDER } from './architecture/mermaid.js';
export { classifyFile } from './architecture/classify.js';

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

/**
 * Ecosystems whose default artifact is an application / service, not an
 * npm-style library. Without this, a `type: 'dotnet'` tree with no npm
 * deps is scored `library` just because ARCHETYPE_SIGNALS is JS-only.
 */
const NON_LIBRARY_DEFAULT_TYPES: ReadonlySet<ProjectType> = new Set([
  'dotnet',
  'python',
  'java',
  'go',
  'rust',
  'php',
  'ruby',
  'swift',
  'kotlin',
  'dart',
  'scala',
  'elixir',
  'c',
  'cpp',
  'cobol',
  'fortran',
  'visual-basic',
  'pascal',
  'ada',
  'rpg',
  'objective-c',
  'groovy',
]);

function detectArchetype(projects: ProjectScan[]): { archetype: ProjectArchetype; confidence: number } {
  const allPackages = new Set<string>();
  for (const p of projects) {
    for (const d of p.dependencies) {
      allPackages.add(d.package);
    }
  }

  // Score each archetype from package signals. Never short-circuit to
  // `monorepo` from project count — workspace composition is `workspaceShape`.
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

  // JS/TS with no recognisable framework is typically a library. Other
  // ecosystems stay `unknown` so Program.cs is not labelled `library`.
  if (bestArchetype === 'unknown') {
    const hasNonLibraryType = projects.some((p) => NON_LIBRARY_DEFAULT_TYPES.has(p.type));
    if (!hasNonLibraryType) {
      bestArchetype = 'library';
      bestScore = 3;
    }
  }

  // Confidence is normalised — max possible score for a single match is ~20
  const confidence = Math.min(bestScore / 15, 1);
  return { archetype: bestArchetype, confidence: Math.round(confidence * 100) / 100 };
}

const FRAMEWORK_TO_ARCHETYPE: Record<string, ProjectArchetype> = {
  nextjs: 'nextjs',
  nestjs: 'nestjs',
  express: 'express',
  remix: 'remix',
  sveltekit: 'sveltekit',
  nuxt: 'nuxt',
  fastify: 'fastify',
  hono: 'hono',
  koa: 'koa',
  serverless: 'serverless',
  spring: 'spring',
  aspnet: 'aspnet',
  django: 'django',
  fastapi: 'fastapi',
};

const FRAMEWORK_TO_PROJECT_KIND: Record<string, string> = {
  nextjs: 'web-app',
  remix: 'web-app',
  sveltekit: 'web-app',
  nuxt: 'web-app',
  nestjs: 'web-api',
  express: 'web-api',
  fastify: 'web-api',
  hono: 'web-api',
  koa: 'web-api',
  spring: 'web-api',
  aspnet: 'web-api',
  django: 'web-api',
  fastapi: 'web-api',
  rails: 'web-app',
  laravel: 'web-api',
  phoenix: 'web-api',
  serverless: 'worker',
};

function projectKindFromFramework(framework: string | undefined): string | undefined {
  if (!framework) return undefined;
  return FRAMEWORK_TO_PROJECT_KIND[framework];
}

function deriveArchetype(
  detected: { archetype: ProjectArchetype; confidence: number },
  fusion: FusionResult,
): { archetype: ProjectArchetype; confidence: number } {
  const fw = fusion.winners.get('framework');
  const pk = fusion.winners.get('projectKind');
  const lang = fusion.winners.get('language');
  if (fw) {
    const mapped = FRAMEWORK_TO_ARCHETYPE[fw.value];
    if (mapped) {
      if (
        detected.archetype !== 'unknown' &&
        detected.archetype !== 'library' &&
        detected.archetype !== mapped
      ) {
        return detected;
      }
      return { archetype: mapped, confidence: Math.round(fw.confidence * 100) / 100 };
    }
  }
  if (pk?.value === 'cli' && (detected.archetype === 'unknown' || detected.archetype === 'library' || detected.archetype === 'cli')) {
    return { archetype: 'cli', confidence: Math.round(pk.confidence * 100) / 100 };
  }
  if (
    (pk?.value === 'web-api' || pk?.value === 'web-app') &&
    lang?.value === 'go' &&
    (detected.archetype === 'unknown' || detected.archetype === 'library')
  ) {
    return { archetype: 'go-service', confidence: Math.round(Math.min(pk.confidence, 0.85) * 100) / 100 };
  }
  return detected;
}

function computeSupportLevel(
  fusion: FusionResult,
  classifiedCount: number,
  projectType: string,
): ArchitectureSupportLevel {
  if (classifiedCount > 0) return 2;
  if (fusion.winners.has('projectKind') || fusion.winners.has('framework') || fusion.winners.has('buildSystem')) {
    return 1;
  }
  if (fusion.winners.has('language') && !UNCLASSIFIED_BY_DESIGN.has(projectType as ProjectType)) {
    return 1;
  }
  return 0;
}

function buildProjectContext(project: ProjectScan, files: readonly string[]): ProjectContext {
  const fileNames = new Set<string>();
  const extensions = new Set<string>();
  for (const f of files) {
    const base = path.basename(f);
    fileNames.add(base.toLowerCase());
    const ext = path.extname(base).toLowerCase();
    if (ext) extensions.add(ext);
  }
  const packages = new Set<string>();
  for (const d of project.dependencies) packages.add(d.package);
  return {
    project,
    files,
    fileNames,
    extensions,
    packages,
    frameworkNames: (project.frameworks ?? []).map((f) => f.name),
    projectPath: project.path || '.',
    projectType: project.type,
  };
}

function inferContractKind(files: readonly string[]): { contractKind?: string; semanticRole?: string } {
  const kinds = new Set<string>();
  for (const f of files) {
    const kind = contractKindFromName(f, path.basename(f));
    if (kind) kinds.add(kind);
  }
  if (kinds.size === 0) return {};
  const contractKind = [...kinds].sort((a, b) => a.localeCompare(b))[0];
  const semanticRole =
    contractKind === 'asyncapi' ? 'event-contract' :
    contractKind === 'protobuf' ? 'domain-contract' :
    contractKind === 'openapi' || contractKind === 'graphql' ? 'api-contract' :
    undefined;
  return { contractKind, semanticRole };
}

function isLayerCandidate(filePath: string): boolean {
  const name = path.basename(filePath);
  if (isBuildBasename(name)) return false;
  if (isContractOrIacFile(filePath, name)) return false;
  const ext = path.extname(name).toLowerCase();
  if (ext === '.csproj' || ext === '.fsproj' || ext === '.vbproj' || ext === '.sln') return false;
  return true;
}

/** Dockerfile / Helm / Terraform overlays — not language ecosystems. */
const OVERLAY_PROJECT_TYPES = new Set<string>(['docker', 'helm', 'terraform']);

function isOverlayProject(project: ProjectScan): boolean {
  return OVERLAY_PROJECT_TYPES.has(project.type as string);
}

function inferWorkspaceShape(projects: ProjectScan[]): WorkspaceShape {
  const apps = projects.filter((p) => !isOverlayProject(p));
  if (apps.length < 2) return 'single';
  const types = new Set(apps.map((p) => p.type));
  return types.size >= 2 ? 'polyglot-platform' : 'monorepo';
}

function compareRelPath(a: string, b: string): number {
  return a.replace(/\\/g, '/').localeCompare(b.replace(/\\/g, '/'));
}

function normalizeRelPath(p: string): string {
  return (p || '.').replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '') || '.';
}

function toRepoRelative(projectPath: string, filePath: string): string {
  const normalised = filePath.replace(/\\/g, '/');
  const prefix = normalizeRelPath(projectPath);
  if (!prefix || prefix === '.') return normalised;
  return `${prefix}/${normalised}`;
}

function pathOwnsFile(projectPath: string, file: string): boolean {
  const prefix = normalizeRelPath(projectPath);
  const f = file.replace(/\\/g, '/');
  if (prefix === '.') return true;
  return f === prefix || f.startsWith(`${prefix}/`);
}

/** Most-specific project path that contains `file` (longest prefix wins). */
function owningProjectPath(file: string, projectPaths: readonly string[]): string {
  let best = '.';
  let bestLen = -1;
  for (const raw of projectPaths) {
    const p = normalizeRelPath(raw);
    if (!pathOwnsFile(p, file)) continue;
    const len = p === '.' ? 0 : p.length;
    if (len > bestLen) {
      best = p;
      bestLen = len;
    }
  }
  return best;
}

const LAYER_ORDER: Record<ArchitectureLayer, number> = {
  presentation: 0,
  routing: 1,
  middleware: 2,
  services: 3,
  domain: 4,
  'data-access': 5,
  infrastructure: 6,
  config: 7,
  shared: 8,
  testing: 9,
};

export interface ArchitectureScanBundle {
  workspace: ArchitectureResult;
  /** One result per input project, same order. Same-path overlays share one object. */
  projectResults: ArchitectureResult[];
}

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

  // ── .NET (NuGet package ids) ──
  'Microsoft.EntityFrameworkCore': 'data-access',
  'Dapper': 'data-access',
  'Npgsql': 'data-access',
  'Microsoft.Data.SqlClient': 'data-access',
  'System.Data.SqlClient': 'data-access',
  'MongoDB.Driver': 'data-access',
  'StackExchange.Redis': 'data-access',
  'MediatR': 'services',
  'Hangfire': 'services',
  'Quartz': 'services',
  'FluentValidation': 'domain',
  'AutoMapper': 'domain',
  'Microsoft.AspNetCore.Authentication.JwtBearer': 'middleware',
  'Swashbuckle.AspNetCore': 'routing',
  'Serilog': 'infrastructure',
  'NLog': 'infrastructure',
  'Polly': 'infrastructure',
  'RabbitMQ.Client': 'infrastructure',
  'MassTransit': 'infrastructure',
  'Confluent.Kafka': 'infrastructure',
  'Azure.Storage.Blobs': 'infrastructure',
  'AWSSDK.S3': 'infrastructure',
  'Newtonsoft.Json': 'shared',
  'xunit': 'testing',
  'NUnit': 'testing',
  'MSTest.TestFramework': 'testing',
  'Moq': 'testing',
  'NSubstitute': 'testing',
  'FluentAssertions': 'testing',

  // ── Python (PyPI) ──
  'django': 'routing',
  'flask': 'routing',
  'fastapi': 'routing',
  'starlette': 'routing',
  'sqlalchemy': 'data-access',
  'alembic': 'data-access',
  'psycopg2': 'data-access',
  'psycopg2-binary': 'data-access',
  'pymongo': 'data-access',
  'pydantic': 'domain',
  'marshmallow': 'domain',
  'celery': 'services',
  'pytest': 'testing',
  'boto3': 'infrastructure',
  'httpx': 'infrastructure',
  'requests': 'infrastructure',
  'gunicorn': 'infrastructure',
  'uvicorn': 'infrastructure',
  'structlog': 'infrastructure',

  // ── JVM (Maven groupId:artifactId, as the Java scanner keys them) ──
  'org.springframework.boot:spring-boot-starter-web': 'routing',
  'org.springframework:spring-webmvc': 'routing',
  'io.ktor:ktor-server-core': 'routing',
  'io.quarkus:quarkus-resteasy': 'routing',
  'org.springframework.boot:spring-boot-starter-data-jpa': 'data-access',
  'org.hibernate:hibernate-core': 'data-access',
  'org.hibernate.orm:hibernate-core': 'data-access',
  'org.mybatis:mybatis': 'data-access',
  'com.zaxxer:HikariCP': 'data-access',
  'org.jetbrains.exposed:exposed-core': 'data-access',
  'org.springframework.boot:spring-boot-starter-security': 'middleware',
  'jakarta.validation:jakarta.validation-api': 'domain',
  'com.fasterxml.jackson.core:jackson-databind': 'shared',
  'org.projectlombok:lombok': 'shared',
  'junit:junit': 'testing',
  'org.junit.jupiter:junit-jupiter': 'testing',
  'org.mockito:mockito-core': 'testing',
  'org.testng:testng': 'testing',
  'ch.qos.logback:logback-classic': 'infrastructure',
  'org.slf4j:slf4j-api': 'infrastructure',
  'org.apache.kafka:kafka-clients': 'infrastructure',
  'com.squareup.okhttp3:okhttp': 'infrastructure',

  // ── Go (module paths) ──
  'github.com/gin-gonic/gin': 'routing',
  'github.com/labstack/echo/v4': 'routing',
  'github.com/gorilla/mux': 'routing',
  'github.com/go-chi/chi/v5': 'routing',
  'github.com/gofiber/fiber/v2': 'routing',
  'github.com/spf13/cobra': 'routing',
  'gorm.io/gorm': 'data-access',
  'github.com/jmoiron/sqlx': 'data-access',
  'github.com/jackc/pgx/v5': 'data-access',
  'go.mongodb.org/mongo-driver': 'data-access',
  'github.com/redis/go-redis/v9': 'data-access',
  'github.com/spf13/viper': 'config',
  'github.com/stretchr/testify': 'testing',
  'go.uber.org/zap': 'infrastructure',
  'github.com/sirupsen/logrus': 'infrastructure',
  'google.golang.org/grpc': 'infrastructure',

  // ── Rust (crates) ──
  'actix-web': 'routing',
  'axum': 'routing',
  'rocket': 'routing',
  'warp': 'routing',
  'clap': 'routing',
  'diesel': 'data-access',
  'sqlx': 'data-access',
  'sea-orm': 'data-access',
  'serde': 'domain',
  'tokio': 'infrastructure',
  'reqwest': 'infrastructure',
  'tracing': 'infrastructure',

  // ── Ruby (gems) ──
  'rails': 'routing',
  'sinatra': 'routing',
  'activerecord': 'data-access',
  'sequel': 'data-access',
  'devise': 'middleware',
  'pundit': 'middleware',
  'sidekiq': 'services',
  'rspec': 'testing',
  'rspec-rails': 'testing',
  'minitest': 'testing',
  'puma': 'infrastructure',
  'faraday': 'infrastructure',

  // ── PHP (Composer vendor/package) ──
  'laravel/framework': 'routing',
  'symfony/http-kernel': 'routing',
  'slim/slim': 'routing',
  'doctrine/orm': 'data-access',
  'illuminate/database': 'data-access',
  'phpunit/phpunit': 'testing',
  'pestphp/pest': 'testing',
  'guzzlehttp/guzzle': 'infrastructure',
  'monolog/monolog': 'infrastructure',

  // ── Swift (SPM) ──
  'Alamofire': 'infrastructure',
  'vapor': 'routing',
  'Vapor': 'routing',

  // ── Dart (pub) ──
  'dio': 'infrastructure',
  'sqflite': 'data-access',
  'flutter_bloc': 'services',
  'riverpod': 'services',
  'flutter_riverpod': 'services',
  'go_router': 'routing',
  'auto_route': 'routing',
  'flutter_test': 'testing',
  'mockito': 'testing',

  // ── Elixir (Hex) ──
  'phoenix': 'routing',
  'phoenix_live_view': 'presentation',
  'ecto': 'data-access',
  'ecto_sql': 'data-access',
  'postgrex': 'data-access',
  'oban': 'services',
  'ex_machina': 'testing',
  'tesla': 'infrastructure',
  'httpoison': 'infrastructure',
  'finch': 'infrastructure',
  'jason': 'shared',
};

// ── Source file walker ──

/** Frozen union plus additive pack extensions. Packs never remove from this set. */
const SOURCE_EXTENSIONS = collectWalkExtensions(ARCHITECTURE_PACKS);

function isWalkedFileName(name: string): boolean {
  if (name.startsWith('.') && name !== '.') return false;
  const ext = path.extname(name).toLowerCase();
  return SOURCE_EXTENSIONS.has(ext) || isContractBasename(name) || isBuildBasename(name);
}

async function walkSourceFiles(rootDir: string, cache?: FileCache): Promise<string[]> {
  if (cache) {
    // Reuse a cached ancestor walk (workspace root) and filter to this
    // directory — never re-walk a monorepo once per project.
    const entries = await cache.walkDirUnder(rootDir);
    return entries
      .filter((e) => {
        if (!e.isFile) return false;
        return isWalkedFileName(path.basename(e.absPath));
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
        // Same skip list as every other scanner (SKIP_DIRS + virtualenv
        // variants) so build output, vendored deps and caches never classify.
        if (!isSkippedDirName(entry.name)) {
          await walk(fullPath);
        }
      } else if (entry.isFile()) {
        if (isWalkedFileName(entry.name)) {
          files.push(path.relative(rootDir, fullPath));
        }
      }
    }
  }

  await walk(rootDir);
  return files;
}

// ── Per-layer drift scoring ──

function computeLayerDrift(packages: LayerPackageRef[]): { score: number; riskLevel: RiskLevel } {
  if (packages.length === 0) {
    return { score: 0, riskLevel: 'none' };
  }

  let current = 0;
  let oneBehind = 0;
  let twoPlusBehind = 0;

  for (const pkg of packages) {
    if (pkg.majorsBehind === null) {
      // Unknown currency — excluded from the drift ratio below.
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

  const orderedLayers = LAYER_FLOW_ORDER.filter((l) => layerSet.has(l));
  return generateLayerFlowMermaid(orderedLayers);
}

/**
 * Run architecture detection scoped to a single project directory.
 * File paths in the result are repo-relative (`project.path` + walked path).
 * When `workspaceProjects` is provided, files owned by a more-specific
 * sibling project are excluded so a root package does not re-classify
 * `packages/*`.
 */
export async function scanProjectArchitecture(
  rootDir: string,
  project: ProjectScan,
  cache?: FileCache,
  workspaceProjects?: ProjectScan[],
): Promise<ArchitectureResult> {
  const projectRoot = path.resolve(rootDir, project.path || '.');
  const siblings = workspaceProjects ?? [project];
  return classifyTree(projectRoot, [project], undefined, undefined, cache, {
    projectPath: project.path,
    workspacePaths: siblings.map((p) => p.path),
  });
}

/**
 * Aggregate per-project ArchitectureResults into a single solution-level result.
 * Merges layer summaries (summing file counts, merging packages/tech/services),
 * picks the most-confident archetype across member projects.
 */
function uniqueResultsForAggregate(
  projectResults: ArchitectureResult[],
  projects?: ProjectScan[],
): ArchitectureResult[] {
  if (projects && projects.length === projectResults.length) {
    const byPath = new Map<string, ArchitectureResult>();
    const ownerOverlay = new Map<string, boolean>();
    for (let i = 0; i < projects.length; i++) {
      const key = normalizeRelPath(projects[i]!.path);
      const overlay = isOverlayProject(projects[i]!);
      const existing = byPath.get(key);
      if (!existing) {
        byPath.set(key, projectResults[i]!);
        ownerOverlay.set(key, overlay);
      } else if (ownerOverlay.get(key) && !overlay) {
        byPath.set(key, projectResults[i]!);
        ownerOverlay.set(key, false);
      }
    }
    return [...byPath.values()];
  }
  return [...new Set(projectResults)];
}

export function aggregateSolutionArchitecture(
  projectResults: ArchitectureResult[],
  projects?: ProjectScan[],
): ArchitectureResult {
  const unique = uniqueResultsForAggregate(projectResults, projects);
  if (unique.length === 0) {
    const empty: ArchitectureResult = { archetype: 'unknown', archetypeConfidence: 0, layers: [], totalClassified: 0, unclassified: 0 };
    if (projects) empty.workspaceShape = inferWorkspaceShape(projects);
    return empty;
  }
  if (unique.length === 1) {
    const single = { ...unique[0]!, layers: unique[0]!.layers.map((ls) => ({ ...ls, packages: [...ls.packages], techStack: [...ls.techStack], services: [...ls.services], files: [...ls.files] })) };
    if (projects) single.workspaceShape = inferWorkspaceShape(projects);
    return single;
  }

  // Highest-confidence per-project archetype. Never promote `monorepo`.
  let bestArchetype: ProjectArchetype = 'unknown';
  let bestConfidence = 0;
  for (const r of unique) {
    if (r.archetype === 'monorepo') continue;
    if (
      r.archetypeConfidence > bestConfidence ||
      (r.archetypeConfidence === bestConfidence && r.archetype !== 'unknown')
    ) {
      bestArchetype = r.archetype;
      bestConfidence = r.archetypeConfidence;
    }
  }

  // Merge layer summaries
  const layerMap = new Map<ArchitectureLayer, LayerSummary>();
  for (const r of unique) {
    for (const ls of r.layers) {
      const existing = layerMap.get(ls.layer);
      if (!existing) {
        const files = [...ls.files].sort(compareRelPath).slice(0, 40);
        layerMap.set(ls.layer, { ...ls, packages: [...ls.packages], techStack: [...ls.techStack], services: [...ls.services], files });
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
        // Merge files (dedup, then sort + cap — walk order is not deterministic)
        const seenFiles = new Set(existing.files);
        for (const f of ls.files) {
          if (!seenFiles.has(f)) {
            existing.files.push(f);
            seenFiles.add(f);
          }
        }
        existing.files.sort(compareRelPath);
        if (existing.files.length > 40) existing.files.length = 40;
        // Recompute drift for merged packages
        const { score, riskLevel } = computeLayerDrift(existing.packages);
        existing.driftScore = score;
        existing.riskLevel = riskLevel;
      }
    }
  }

  const layers = [...layerMap.values()].sort((a, b) => (LAYER_ORDER[a.layer] ?? 99) - (LAYER_ORDER[b.layer] ?? 99));

  const totalClassified = unique.reduce((s, r) => s + r.totalClassified, 0);
  const unclassified = unique.reduce((s, r) => s + r.unclassified, 0);

  const aggregated: ArchitectureResult = { archetype: bestArchetype, archetypeConfidence: bestConfidence, layers, totalClassified, unclassified };
  applyAggregatedPackFields(aggregated, unique);
  if (projects) aggregated.workspaceShape = inferWorkspaceShape(projects);
  return aggregated;
}

function applyAggregatedPackFields(target: ArchitectureResult, unique: ArchitectureResult[]): void {
  const packIds = new Set<string>();
  let maxSupport: ArchitectureSupportLevel | undefined;
  const kinds = new Set<string>();
  const artifacts = new Set<string>();
  const allEvidence: ArchitectureEvidence[] = [];
  const allEdges: ArchitectureWorkspaceEdge[] = [];
  const allViolations: ArchitectureViolation[] = [];
  let anyViolationsField = false;
  let bestStructure: ArchitectureResult['structure'];
  let bestProfile: string | undefined;
  for (const r of unique) {
    for (const id of r.packIds ?? []) packIds.add(id);
    if (r.supportLevel !== undefined) {
      maxSupport = (maxSupport === undefined ? r.supportLevel : Math.max(maxSupport, r.supportLevel)) as ArchitectureSupportLevel;
    }
    if (r.projectKind) kinds.add(r.projectKind);
    if (r.artifactKind) artifacts.add(r.artifactKind);
    if (r.evidence) allEvidence.push(...r.evidence);
    if (r.workspaceEdges) allEdges.push(...r.workspaceEdges);
    if (r.violations !== undefined) {
      anyViolationsField = true;
      allViolations.push(...r.violations);
    }
    if (r.structure && (!bestStructure
      || r.structure.confidence > bestStructure.confidence
      || (r.structure.confidence === bestStructure.confidence
        && r.structure.primary.localeCompare(bestStructure.primary) < 0))) {
      bestStructure = r.structure;
      bestProfile = r.boundaryProfile;
    } else if (
      r.structure
      && bestStructure
      && r.structure.confidence === bestStructure.confidence
      && r.structure.primary === bestStructure.primary
      && r.boundaryProfile
      && (!bestProfile || r.boundaryProfile.localeCompare(bestProfile) < 0)
    ) {
      bestProfile = r.boundaryProfile;
    } else if (
      !r.structure
      && !bestStructure
      && r.boundaryProfile
      && (!bestProfile || r.boundaryProfile.localeCompare(bestProfile) < 0)
    ) {
      bestProfile = r.boundaryProfile;
    }
  }
  if (packIds.size > 0) target.packIds = [...packIds].sort((a, b) => a.localeCompare(b));
  if (maxSupport !== undefined) target.supportLevel = maxSupport;
  if (kinds.size === 1) target.projectKind = [...kinds][0];
  if (artifacts.size === 1) target.artifactKind = [...artifacts][0];
  const folders = mergeFolderClassifications(unique.map((r) => r.folders));
  if (folders) target.folders = folders;
  else delete target.folders;
  const unclassifiedFiles = mergeUnclassifiedFiles(unique.map((r) => r.unclassifiedFiles));
  if (unclassifiedFiles) target.unclassifiedFiles = unclassifiedFiles;
  else delete target.unclassifiedFiles;
  const payload = capEvidence(allEvidence);
  if (payload.evidence) target.evidence = payload.evidence;
  // A child's already-dropped sample must stay flagged. Absent ≠ false.
  if (payload.evidenceCapped || unique.some((r) => r.evidenceCapped)) target.evidenceCapped = true;
  else delete target.evidenceCapped;
  const edges = capWorkspaceEdges(allEdges);
  if (edges.workspaceEdges) target.workspaceEdges = edges.workspaceEdges;
  else delete target.workspaceEdges;
  if (edges.workspaceEdgesCapped || unique.some((r) => r.workspaceEdgesCapped)) target.workspaceEdgesCapped = true;
  else delete target.workspaceEdgesCapped;
  if (anyViolationsField || unique.some((r) => r.violationsCapped)) {
    const capped = capViolations(allViolations);
    target.violations = capped.violations;
    if (capped.violationsCapped || unique.some((r) => r.violationsCapped)) target.violationsCapped = true;
    else delete target.violationsCapped;
  } else {
    delete target.violations;
    delete target.violationsCapped;
  }
  if (bestStructure) target.structure = bestStructure;
  else delete target.structure;
  if (bestProfile) target.boundaryProfile = bestProfile;
  else delete target.boundaryProfile;
}

function overlayToolingServices(
  result: ArchitectureResult,
  projects: ProjectScan[],
  tooling?: ToolingInventoryResult,
  services?: ServiceDependenciesResult,
): ArchitectureResult {
  // Solely contract/IaC workspaces must not grow default layers from packages.
  if (result.projectKind === 'iac' || result.projectKind === 'contract') {
    result.layers = [];
    return result;
  }
  if (!tooling && !services) return result;

  const allDeps = new Map<string, DependencyRow>();
  for (const p of projects) {
    for (const d of p.dependencies) {
      if (!allDeps.has(d.package)) allDeps.set(d.package, d);
    }
  }
  const depsByLayer = new Map<ArchitectureLayer, Set<string>>();
  for (const [pkg] of allDeps) {
    const layer = PACKAGE_LAYER_MAP[pkg];
    if (layer) {
      if (!depsByLayer.has(layer)) depsByLayer.set(layer, new Set());
      depsByLayer.get(layer)!.add(pkg);
    }
  }
  const { layerTooling, layerServices } = mapToolingToLayers(tooling, services, depsByLayer);
  const layerMap = new Map<ArchitectureLayer, LayerSummary>();
  for (const ls of result.layers) {
    layerMap.set(ls.layer, {
      ...ls,
      packages: [...ls.packages],
      techStack: [...ls.techStack],
      services: [...ls.services],
      files: [...ls.files],
    });
  }

  const emptyLayer = (layer: ArchitectureLayer): LayerSummary => ({
    layer,
    fileCount: 0,
    driftScore: 0,
    riskLevel: 'none',
    techStack: [],
    services: [],
    packages: [],
    files: [],
  });

  for (const [layer, items] of layerTooling) {
    const existing = layerMap.get(layer) ?? emptyLayer(layer);
    const seen = new Set(existing.techStack.map((t) => t.package));
    for (const item of items) {
      if (!seen.has(item.package)) existing.techStack.push(item);
    }
    layerMap.set(layer, existing);
  }
  for (const [layer, items] of layerServices) {
    const existing = layerMap.get(layer) ?? emptyLayer(layer);
    const seen = new Set(existing.services.map((s) => s.package));
    for (const item of items) {
      if (!seen.has(item.package)) existing.services.push(item);
    }
    layerMap.set(layer, existing);
  }

  result.layers = [...layerMap.values()].sort((a, b) => (LAYER_ORDER[a.layer] ?? 99) - (LAYER_ORDER[b.layer] ?? 99));
  return result;
}

function finalizeWorkspace(
  results: ArchitectureResult[],
  projects: ProjectScan[],
  tooling?: ToolingInventoryResult,
  services?: ServiceDependenciesResult,
): ArchitectureResult {
  const aggregated = overlayToolingServices(
    aggregateSolutionArchitecture(results, projects),
    projects,
    tooling,
    services,
  );
  if (aggregated.archetype === 'monorepo') {
    aggregated.archetype = 'unknown';
    aggregated.archetypeConfidence = 0;
  }
  aggregated.workspaceShape = inferWorkspaceShape(projects);
  return aggregated;
}

// ── Main scanner entry point ──

export async function scanArchitecture(
  rootDir: string,
  projects: ProjectScan[],
  tooling?: ToolingInventoryResult,
  services?: ServiceDependenciesResult,
  cache?: FileCache,
): Promise<ArchitectureResult> {
  const { workspace } = await scanArchitectureBundle(rootDir, projects, tooling, services, cache);
  return workspace;
}

/**
 * Workspace scan plus per-project results so callers do not re-classify.
 * Same-path overlays (docker/helm/terraform next to an app) share one walk.
 */
export async function scanArchitectureBundle(
  rootDir: string,
  projects: ProjectScan[],
  tooling?: ToolingInventoryResult,
  services?: ServiceDependenciesResult,
  cache?: FileCache,
): Promise<ArchitectureScanBundle> {
  if (projects.length === 0) {
    const workspace = await classifyTree(rootDir, [], tooling, services, cache);
    workspace.workspaceShape = 'single';
    return { workspace, projectResults: [] };
  }

  const sorted = [...projects].sort((a, b) => compareRelPath(a.path, b.path) || a.name.localeCompare(b.name));
  const ownerByPath = new Map<string, ProjectScan>();
  for (const p of sorted) {
    const key = normalizeRelPath(p.path);
    const existing = ownerByPath.get(key);
    if (!existing || (isOverlayProject(existing) && !isOverlayProject(p))) {
      ownerByPath.set(key, p);
    }
  }
  const owners = [...ownerByPath.values()];

  const resultByPath = new Map<string, ArchitectureResult>();
  await Promise.all(owners.map(async (owner) => {
    const result = await scanProjectArchitecture(rootDir, owner, cache, owners);
    resultByPath.set(normalizeRelPath(owner.path), result);
  }));

  const projectResults = projects.map((p) => resultByPath.get(normalizeRelPath(p.path))!);
  const uniqueResults = [...resultByPath.values()];
  const workspace = finalizeWorkspace(uniqueResults, projects, tooling, services);
  const siblingEdges = detectWorkspaceEdges(projects, projectResults);
  const mergedEdges = [
    ...(workspace.workspaceEdges ?? []),
    ...siblingEdges,
  ];
  const alreadyEdgesCapped = workspace.workspaceEdgesCapped === true
    || uniqueResults.some((r) => r.workspaceEdgesCapped)
    || projectResults.some((r) => r.workspaceEdgesCapped);
  const capped = capWorkspaceEdges(mergedEdges);
  if (capped.workspaceEdges) workspace.workspaceEdges = capped.workspaceEdges;
  else delete workspace.workspaceEdges;
  // Never clear a true cap flag because this recap did not drop more items.
  if (capped.workspaceEdgesCapped || alreadyEdgesCapped) workspace.workspaceEdgesCapped = true;
  else delete workspace.workspaceEdgesCapped;
  return { workspace, projectResults };
}

/** Classify one tree. `projects` supplies archetype signals and package→layer maps. */
async function classifyTree(
  rootDir: string,
  projects: ProjectScan[],
  tooling?: ToolingInventoryResult,
  services?: ServiceDependenciesResult,
  cache?: FileCache,
  scope?: { projectPath: string; workspacePaths: string[] },
): Promise<ArchitectureResult> {
  // 1. Detect project archetype from package signals (JS back-compat).
  const detected = detectArchetype(projects);

  // 2. Walk source files. When a workspace scope is set, keep only files
  // this project owns (most-specific path) so a root package does not
  // re-classify nested projects.
  let sourceFiles = await walkSourceFiles(rootDir, cache);
  if (scope) {
    const owner = normalizeRelPath(scope.projectPath);
    const uniquePaths = [...new Set(scope.workspacePaths.map(normalizeRelPath))];
    sourceFiles = sourceFiles.filter((f) => {
      const repoRel = toRepoRelative(scope.projectPath, f);
      return owningProjectPath(repoRel, uniquePaths) === owner;
    });
  }

  const primary = projects[0] ?? {
    type: 'node' as ProjectType,
    path: scope?.projectPath ?? '.',
    name: '',
    frameworks: [],
    dependencies: [],
    dependencyAgeBuckets: { current: 0, oneBehind: 0, twoPlusBehind: 0, unknown: 0 },
  };
  const context = buildProjectContext(primary, sourceFiles);
  const { evidence: rawEvidence } = collectPackEvidence(ARCHITECTURE_PACKS, context);
  const fusion = fuseEvidence(rawEvidence);
  const { archetype, confidence: archetypeConfidence } = deriveArchetype(detected, fusion);
  const projectKind = fusion.winners.get('projectKind')?.value ?? projectKindFromFramework(fusion.winners.get('framework')?.value);
  const artifactKind = fusion.winners.get('artifactKind')?.value;
  const skipAllLayers = projectKind === 'iac' || projectKind === 'contract';

  // 3. Classify each file into a layer on the project-local path so a
  // folder named `api` / `ui` does not itself match PATH_RULES. Prefix
  // only the stored sample path. Contract / IaC files are not source
  // and must not become "unclassified" or pick up a default layer.
  sourceFiles.sort(compareRelPath);
  const seedClassified: LayerClassification[] = [];
  const seedUnclassified: string[] = [];

  for (const file of sourceFiles) {
    if (!isLayerCandidate(file) || skipAllLayers) continue;
    const storedPath = scope ? toRepoRelative(scope.projectPath, file) : file;
    const classification = classifyFile(file, archetype);
    if (classification) {
      seedClassified.push({ ...classification, filePath: storedPath });
    } else {
      seedUnclassified.push(storedPath);
    }
  }

  const inherited = skipAllLayers
    ? { classified: [] as LayerClassification[], folders: [] as FolderClassification[], unclassifiedSource: [] as string[] }
    : applyFolderInheritance({ classified: seedClassified, unclassifiedSource: seedUnclassified });
  const classifications = inherited.classified;
  const unclassified = inherited.unclassifiedSource.length;

  // 4. Build dependency map: collect all packages used across projects
  const allDeps = new Map<string, DependencyRow>();
  for (const p of projects) {
    for (const d of p.dependencies) {
      if (!allDeps.has(d.package)) {
        allDeps.set(d.package, d);
      }
    }
  }

  // 5–6. Packages/tooling become layers only for source projects. Contract
  // and IaC must not pick up a default domain/routing layer from deps.
  const depsByLayer = new Map<ArchitectureLayer, Set<string>>();
  if (!skipAllLayers) {
    for (const [pkg] of allDeps) {
      const layer = PACKAGE_LAYER_MAP[pkg];
      if (layer) {
        if (!depsByLayer.has(layer)) depsByLayer.set(layer, new Set());
        depsByLayer.get(layer)!.add(pkg);
      }
    }
  }

  const { layerTooling, layerServices } = skipAllLayers
    ? { layerTooling: new Map<ArchitectureLayer, InventoryItem[]>(), layerServices: new Map<ArchitectureLayer, ServiceDependencyItem[]>() }
    : mapToolingToLayers(tooling, services, depsByLayer);

  // 7. Aggregate into layer summaries
  const ALL_LAYERS: ArchitectureLayer[] = [
    'routing', 'middleware', 'services', 'domain',
    'data-access', 'infrastructure', 'presentation',
    'config', 'testing', 'shared',
  ];

  const LAYER_FILES_CAP = 40;
  const layerFileCounts = new Map<ArchitectureLayer, number>();
  const layerFiles = new Map<ArchitectureLayer, string[]>();
  for (const c of classifications) {
    layerFileCounts.set(c.layer, (layerFileCounts.get(c.layer) ?? 0) + 1);
    const existing = layerFiles.get(c.layer);
    if (existing) {
      if (existing.length < LAYER_FILES_CAP) existing.push(c.filePath);
    } else {
      layerFiles.set(c.layer, [c.filePath]);
    }
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
      files: layerFiles.get(layer) ?? [],
    });
  }

  layers.sort((a, b) => (LAYER_ORDER[a.layer] ?? 99) - (LAYER_ORDER[b.layer] ?? 99));

  const result: ArchitectureResult = {
    archetype,
    archetypeConfidence,
    layers: skipAllLayers ? [] : layers,
    totalClassified: classifications.length,
    unclassified,
  };
  if (!skipAllLayers && inherited.folders.length > 0) result.folders = inherited.folders;
  const unclassifiedSample = capUnclassifiedFiles(inherited.unclassifiedSource);
  if (unclassifiedSample) result.unclassifiedFiles = unclassifiedSample;

  const supportLevel = computeSupportLevel(fusion, classifications.length, primary.type);
  result.supportLevel = supportLevel;
  if (fusion.packIds.length > 0) result.packIds = fusion.packIds;
  if (projectKind) result.projectKind = projectKind;
  if (artifactKind) result.artifactKind = artifactKind;

  const contractMeta = inferContractKind(sourceFiles);
  if (projectKind === 'contract' || contractMeta.contractKind) {
    if (contractMeta.contractKind) result.contractKind = contractMeta.contractKind;
    if (projectKind === 'contract' && contractMeta.semanticRole) result.semanticRole = contractMeta.semanticRole;
  }

  const generated = detectGeneratedMeta(sourceFiles);
  if (generated.generated) {
    result.generated = true;
    if (generated.generatedBy) result.generatedBy = generated.generatedBy;
    const proto = sourceFiles.find((f) => f.toLowerCase().endsWith('.proto'));
    if (proto && generated.generatedBy === 'protoc') {
      result.sourceContract = scope ? toRepoRelative(scope.projectPath, proto) : proto;
    }
  }

  const payload = capEvidence(fusion.evidence);
  if (payload.evidence) result.evidence = payload.evidence;
  if (payload.evidenceCapped) result.evidenceCapped = true;

  const localEdges = detectLocalContractEdges(primary.path, sourceFiles, projectKind);
  const cappedEdges = capWorkspaceEdges(localEdges);
  if (cappedEdges.workspaceEdges) result.workspaceEdges = cappedEdges.workspaceEdges;
  if (cappedEdges.workspaceEdgesCapped) result.workspaceEdgesCapped = true;

  return result;
}
