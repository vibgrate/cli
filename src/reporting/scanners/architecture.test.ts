import { describe, it, expect, beforeEach } from 'vitest';
import { scanArchitecture, buildProjectArchitectureMermaid } from './architecture.js';
import type { ProjectScan, DependencyRow, ToolingInventoryResult, ServiceDependenciesResult } from '../../core-open/index.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

// ── Test helpers ──

function makeDep(pkg: string, version: string | null = '1.0.0', majorsBehind: number = 0): DependencyRow {
  return {
    package: pkg,
    section: 'dependencies',
    currentSpec: version ? `^${version}` : '*',
    resolvedVersion: version,
    latestStable: version,
    majorsBehind,
    drift: majorsBehind === 0 ? 'current' : majorsBehind >= 2 ? 'major-behind' : 'minor-behind' as DependencyRow['drift'],
  };
}

function makeProject(deps: DependencyRow[], name = 'test-project'): ProjectScan {
  return {
    type: 'node',
    path: '.',
    name,
    frameworks: [],
    dependencies: deps,
    dependencyAgeBuckets: { current: 0, oneBehind: 0, twoPlusBehind: 0, unknown: 0 },
  };
}

async function createTempDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'vibgrate-arch-test-'));
}

async function createFiles(rootDir: string, files: string[]): Promise<void> {
  for (const file of files) {
    const fullPath = path.join(rootDir, file);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, `// ${file}\n`);
  }
}

async function cleanupDir(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    // ignore cleanup failures
  }
}

// ── Tests ──

describe('scanArchitecture', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTempDir();
  });

  it('returns unknown archetype for empty project list with no files', async () => {
    const result = await scanArchitecture(tmpDir, []);
    expect(result.archetype).toBe('library');
    expect(result.layers).toEqual([]);
    expect(result.totalClassified).toBe(0);
    expect(result.unclassified).toBe(0);
    await cleanupDir(tmpDir);
  });

  it('detects Express archetype from dependencies', async () => {
    await createFiles(tmpDir, ['src/index.ts']);
    const project = makeProject([makeDep('express', '4.18.0')]);
    const result = await scanArchitecture(tmpDir, [project]);
    expect(result.archetype).toBe('express');
    expect(result.archetypeConfidence).toBeGreaterThan(0);
    await cleanupDir(tmpDir);
  });

  it('detects Next.js archetype from dependencies', async () => {
    await createFiles(tmpDir, ['src/index.ts']);
    const project = makeProject([makeDep('next', '14.1.0'), makeDep('react', '18.2.0')]);
    const result = await scanArchitecture(tmpDir, [project]);
    expect(result.archetype).toBe('nextjs');
    await cleanupDir(tmpDir);
  });

  it('detects NestJS archetype from dependencies', async () => {
    await createFiles(tmpDir, ['src/index.ts']);
    const project = makeProject([makeDep('@nestjs/core', '10.0.0'), makeDep('@nestjs/common', '10.0.0')]);
    const result = await scanArchitecture(tmpDir, [project]);
    expect(result.archetype).toBe('nestjs');
    await cleanupDir(tmpDir);
  });

  it('detects CLI archetype from commander dependency', async () => {
    await createFiles(tmpDir, ['src/cli.ts']);
    const project = makeProject([makeDep('commander', '12.0.0')]);
    const result = await scanArchitecture(tmpDir, [project]);
    expect(result.archetype).toBe('cli');
    await cleanupDir(tmpDir);
  });

  it('detects monorepo when >2 projects', async () => {
    await createFiles(tmpDir, ['packages/a/src/index.ts', 'packages/b/src/index.ts', 'packages/c/src/index.ts']);
    const projects = [
      makeProject([], 'app-a'),
      makeProject([], 'app-b'),
      makeProject([], 'app-c'),
    ];
    const result = await scanArchitecture(tmpDir, projects);
    expect(result.archetype).toBe('monorepo');
    await cleanupDir(tmpDir);
  });

  // ── Layer classification tests ──

  it('classifies test files into testing layer', async () => {
    await createFiles(tmpDir, [
      'src/utils.test.ts',
      'src/__tests__/helper.ts',
      'src/main.spec.ts',
    ]);
    const result = await scanArchitecture(tmpDir, [makeProject([])]);
    const testingLayer = result.layers.find((l) => l.layer === 'testing');
    expect(testingLayer).toBeDefined();
    expect(testingLayer!.fileCount).toBe(3);
    await cleanupDir(tmpDir);
  });

  it('classifies route files into routing layer', async () => {
    await createFiles(tmpDir, [
      'src/routes/users.ts',
      'src/controllers/auth.ts',
      'src/api/health.ts',
    ]);
    const result = await scanArchitecture(tmpDir, [makeProject([])]);
    const routingLayer = result.layers.find((l) => l.layer === 'routing');
    expect(routingLayer).toBeDefined();
    expect(routingLayer!.fileCount).toBe(3);
    await cleanupDir(tmpDir);
  });

  it('carries the classified file paths for each layer, not just the count', async () => {
    await createFiles(tmpDir, [
      'src/routes/users.ts',
      'src/controllers/auth.ts',
      'src/api/health.ts',
    ]);
    const result = await scanArchitecture(tmpDir, [makeProject([])]);
    const routingLayer = result.layers.find((l) => l.layer === 'routing');
    expect(routingLayer).toBeDefined();
    expect(routingLayer!.files.sort()).toEqual(
      ['src/routes/users.ts', 'src/controllers/auth.ts', 'src/api/health.ts'].sort(),
    );
    await cleanupDir(tmpDir);
  });

  it('classifies middleware files into middleware layer', async () => {
    await createFiles(tmpDir, [
      'src/middleware/auth.ts',
      'src/guards/admin.guard.ts',
    ]);
    const project = makeProject([makeDep('@nestjs/core', '10.0.0')]);
    const result = await scanArchitecture(tmpDir, [project]);
    const mwLayer = result.layers.find((l) => l.layer === 'middleware');
    expect(mwLayer).toBeDefined();
    expect(mwLayer!.fileCount).toBe(2);
    await cleanupDir(tmpDir);
  });

  it('classifies service files into services layer', async () => {
    await createFiles(tmpDir, [
      'src/services/user.service.ts',
      'src/services/auth.service.ts',
    ]);
    const result = await scanArchitecture(tmpDir, [makeProject([])]);
    const svcLayer = result.layers.find((l) => l.layer === 'services');
    expect(svcLayer).toBeDefined();
    expect(svcLayer!.fileCount).toBe(2);
    await cleanupDir(tmpDir);
  });

  it('classifies domain/model files into domain layer', async () => {
    await createFiles(tmpDir, [
      'src/domain/user.entity.ts',
      'src/models/order.ts',
    ]);
    const result = await scanArchitecture(tmpDir, [makeProject([])]);
    const domainLayer = result.layers.find((l) => l.layer === 'domain');
    expect(domainLayer).toBeDefined();
    expect(domainLayer!.fileCount).toBe(2);
    await cleanupDir(tmpDir);
  });

  it('classifies data access files into data-access layer', async () => {
    await createFiles(tmpDir, [
      'src/repositories/user.repository.ts',
      'src/db/connection.ts',
      'src/migrations/001_init.ts',
    ]);
    const result = await scanArchitecture(tmpDir, [makeProject([])]);
    const daLayer = result.layers.find((l) => l.layer === 'data-access');
    expect(daLayer).toBeDefined();
    expect(daLayer!.fileCount).toBe(3);
    await cleanupDir(tmpDir);
  });

  it('classifies component files into presentation layer', async () => {
    await createFiles(tmpDir, [
      'src/components/Button.tsx',
      'src/views/Dashboard.tsx',
      'src/layouts/Main.tsx',
    ]);
    const result = await scanArchitecture(tmpDir, [makeProject([makeDep('react', '18.0.0')])]);
    const presLayer = result.layers.find((l) => l.layer === 'presentation');
    expect(presLayer).toBeDefined();
    expect(presLayer!.fileCount).toBe(3);
    await cleanupDir(tmpDir);
  });

  it('classifies infrastructure files into infrastructure layer', async () => {
    await createFiles(tmpDir, [
      'src/infra/s3-client.ts',
      'src/queue/email-worker.ts',
    ]);
    const result = await scanArchitecture(tmpDir, [makeProject([])]);
    const infraLayer = result.layers.find((l) => l.layer === 'infrastructure');
    expect(infraLayer).toBeDefined();
    expect(infraLayer!.fileCount).toBe(2);
    await cleanupDir(tmpDir);
  });

  it('classifies config files into config layer', async () => {
    await createFiles(tmpDir, [
      'src/config/database.ts',
      'src/app.config.ts',
    ]);
    const result = await scanArchitecture(tmpDir, [makeProject([])]);
    const configLayer = result.layers.find((l) => l.layer === 'config');
    expect(configLayer).toBeDefined();
    expect(configLayer!.fileCount).toBe(2);
    await cleanupDir(tmpDir);
  });

  it('classifies shared/utils into shared layer', async () => {
    await createFiles(tmpDir, [
      'src/utils/helpers.ts',
      'src/common/constants.ts',
    ]);
    const result = await scanArchitecture(tmpDir, [makeProject([])]);
    const sharedLayer = result.layers.find((l) => l.layer === 'shared');
    expect(sharedLayer).toBeDefined();
    expect(sharedLayer!.fileCount).toBe(2);
    await cleanupDir(tmpDir);
  });

  // ── Next.js specific classification ──

  it('classifies Next.js route files correctly', async () => {
    await createFiles(tmpDir, [
      'app/api/users/route.ts',
      'app/dashboard/page.tsx',
      'app/layout.tsx',
      'middleware.ts',
    ]);
    const project = makeProject([makeDep('next', '14.0.0')]);
    const result = await scanArchitecture(tmpDir, [project]);

    const routingLayer = result.layers.find((l) => l.layer === 'routing');
    expect(routingLayer).toBeDefined();
    expect(routingLayer!.fileCount).toBeGreaterThanOrEqual(1);

    const presLayer = result.layers.find((l) => l.layer === 'presentation');
    expect(presLayer).toBeDefined();
    expect(presLayer!.fileCount).toBeGreaterThanOrEqual(1);
    await cleanupDir(tmpDir);
  });

  // ── NestJS-specific classification ──

  it('classifies NestJS convention files correctly', async () => {
    await createFiles(tmpDir, [
      'src/users/users.controller.ts',
      'src/users/users.service.ts',
      'src/users/users.module.ts',
      'src/users/user.entity.ts',
      'src/users/users.repository.ts',
      'src/auth/auth.guard.ts',
    ]);
    const project = makeProject([makeDep('@nestjs/core', '10.0.0'), makeDep('@nestjs/common', '10.0.0')]);
    const result = await scanArchitecture(tmpDir, [project]);

    expect(result.archetype).toBe('nestjs');

    const routing = result.layers.find((l) => l.layer === 'routing');
    expect(routing).toBeDefined();
    expect(routing!.fileCount).toBeGreaterThanOrEqual(1); // controller

    const services = result.layers.find((l) => l.layer === 'services');
    expect(services).toBeDefined();
    expect(services!.fileCount).toBeGreaterThanOrEqual(1); // service

    const config = result.layers.find((l) => l.layer === 'config');
    expect(config).toBeDefined(); // module

    const domain = result.layers.find((l) => l.layer === 'domain');
    expect(domain).toBeDefined(); // entity

    const dataAccess = result.layers.find((l) => l.layer === 'data-access');
    expect(dataAccess).toBeDefined(); // repository

    const middleware = result.layers.find((l) => l.layer === 'middleware');
    expect(middleware).toBeDefined(); // guard
    await cleanupDir(tmpDir);
  });

  // ── Drift scoring per layer ──

  it('computes per-layer drift scores from assigned packages', async () => {
    await createFiles(tmpDir, [
      'src/routes/api.ts',
      'src/db/users.ts',
    ]);

    const project = makeProject([
      makeDep('express', '4.18.0', 0),    // routing layer — current
      makeDep('prisma', '3.0.0', 3),      // data-access layer — 3 behind
      makeDep('@prisma/client', '3.0.0', 3),
    ]);
    const result = await scanArchitecture(tmpDir, [project]);

    // Routing layer should have good drift (express is current → 0 drift)
    const routing = result.layers.find((l) => l.layer === 'routing');
    expect(routing).toBeDefined();
    expect(routing!.driftScore).toBe(0);
    expect(routing!.riskLevel).toBe('low');

    // Data access layer should have poor drift (prisma 3 behind → high drift)
    const dataAccess = result.layers.find((l) => l.layer === 'data-access');
    expect(dataAccess).toBeDefined();
    expect(dataAccess!.driftScore).toBeGreaterThanOrEqual(70);
    expect(dataAccess!.riskLevel).toBe('high');
    await cleanupDir(tmpDir);
  });

  // ── Tooling and service attribution ──

  it('maps tooling inventory to correct layers', async () => {
    await createFiles(tmpDir, ['src/index.ts']);
    const project = makeProject([
      makeDep('react', '18.0.0'),
      makeDep('prisma', '5.0.0'),
    ]);

    const tooling: ToolingInventoryResult = {
      frontend: [{ name: 'React', package: 'react', version: '18.0.0' }],
      metaFrameworks: [],
      bundlers: [],
      css: [],
      backend: [],
      orm: [{ name: 'Prisma', package: 'prisma', version: '5.0.0' }],
      testing: [],
      lintFormat: [],
      apiMessaging: [],
      observability: [],
    };

    const result = await scanArchitecture(tmpDir, [project], tooling);

    // React should map to presentation layer
    const presLayer = result.layers.find((l) => l.layer === 'presentation');
    expect(presLayer).toBeDefined();
    expect(presLayer!.techStack.some((t) => t.name === 'React')).toBe(true);

    // Prisma should map to data-access layer
    const daLayer = result.layers.find((l) => l.layer === 'data-access');
    expect(daLayer).toBeDefined();
    expect(daLayer!.techStack.some((t) => t.name === 'Prisma')).toBe(true);
    await cleanupDir(tmpDir);
  });

  it('maps service dependencies to correct layers', async () => {
    await createFiles(tmpDir, ['src/index.ts']);
    const project = makeProject([
      makeDep('stripe', '14.0.0'),
      makeDep('@sendgrid/mail', '8.0.0'),
    ]);

    const services: ServiceDependenciesResult = {
      payment: [{ name: 'Stripe', package: 'stripe', version: '14.0.0' }],
      auth: [],
      email: [{ name: 'SendGrid', package: '@sendgrid/mail', version: '8.0.0' }],
      cloud: [],
      databases: [],
      messaging: [],
      observability: [],
      crm: [],
      storage: [],
      search: [],
    };

    const result = await scanArchitecture(tmpDir, [project], undefined, services);

    // Stripe and SendGrid should map to infrastructure layer
    const infraLayer = result.layers.find((l) => l.layer === 'infrastructure');
    expect(infraLayer).toBeDefined();
    expect(infraLayer!.services.some((s) => s.name === 'Stripe')).toBe(true);
    expect(infraLayer!.services.some((s) => s.name === 'SendGrid')).toBe(true);
    await cleanupDir(tmpDir);
  });

  // ── Ignored directories ──

  it('ignores node_modules and dist directories', async () => {
    await createFiles(tmpDir, [
      'src/index.ts',
      'node_modules/some-lib/index.js',
      'dist/output.js',
    ]);
    const result = await scanArchitecture(tmpDir, [makeProject([])]);
    // Only src/index.ts should be counted (classified or unclassified)
    expect(result.totalClassified + result.unclassified).toBe(1);
    await cleanupDir(tmpDir);
  });

  // ── Unclassified files ──

  it('counts unclassified files when no pattern matches', async () => {
    await createFiles(tmpDir, [
      'src/mysterious-thing.ts',
      'src/another-unknown.ts',
    ]);
    const result = await scanArchitecture(tmpDir, [makeProject([])]);
    expect(result.unclassified).toBe(2);
    await cleanupDir(tmpDir);
  });

  // ── Layer ordering ──

  it('returns layers in architectural order (top to bottom)', async () => {
    await createFiles(tmpDir, [
      'src/components/Button.tsx',
      'src/routes/api.ts',
      'src/middleware/auth.ts',
      'src/services/user.ts',
      'src/domain/user.ts',
      'src/repositories/user.ts',
      'src/infra/s3.ts',
      'src/config/db.ts',
      'src/utils/helpers.ts',
      'src/utils.test.ts',
    ]);
    const result = await scanArchitecture(tmpDir, [makeProject([])]);

    const layerNames = result.layers.map((l) => l.layer);
    const expectedOrder = ['presentation', 'routing', 'middleware', 'services', 'domain', 'data-access', 'infrastructure', 'config', 'shared', 'testing'];

    // Verify relative ordering is maintained
    for (let i = 0; i < layerNames.length - 1; i++) {
      const currentIdx = expectedOrder.indexOf(layerNames[i]!);
      const nextIdx = expectedOrder.indexOf(layerNames[i + 1]!);
      expect(currentIdx).toBeLessThan(nextIdx);
    }
    await cleanupDir(tmpDir);
  });

  // ── CLI archetype-specific rules ──

  it('classifies CLI command files as routing in CLI archetype', async () => {
    await createFiles(tmpDir, [
      'src/commands/init.ts',
      'src/commands/scan.ts',
      'src/formatters/text.ts',
      'src/scanners/node-scanner.ts',
    ]);
    const project = makeProject([makeDep('commander', '12.0.0')]);
    const result = await scanArchitecture(tmpDir, [project]);

    expect(result.archetype).toBe('cli');

    const routing = result.layers.find((l) => l.layer === 'routing');
    expect(routing).toBeDefined();
    expect(routing!.fileCount).toBeGreaterThanOrEqual(2); // commands

    const presentation = result.layers.find((l) => l.layer === 'presentation');
    expect(presentation).toBeDefined();
    expect(presentation!.fileCount).toBeGreaterThanOrEqual(1); // formatters
    await cleanupDir(tmpDir);
  });

  // ── Full realistic scenario ──

  it('handles a full Express app structure', async () => {
    await createFiles(tmpDir, [
      'src/routes/users.ts',
      'src/routes/products.ts',
      'src/middleware/auth.ts',
      'src/middleware/validation.ts',
      'src/services/userService.ts',
      'src/services/productService.ts',
      'src/models/user.ts',
      'src/models/product.ts',
      'src/repositories/userRepo.ts',
      'src/config/database.ts',
      'src/utils/logger.ts',
      'src/index.ts',
      'test/routes.test.ts',
    ]);

    const project = makeProject([
      makeDep('express', '4.18.0', 0),
      makeDep('prisma', '4.0.0', 2),
      makeDep('@prisma/client', '4.0.0', 2),
      makeDep('helmet', '7.0.0', 0),
      makeDep('zod', '3.22.0', 0),
      makeDep('vitest', '1.0.0', 1),
    ]);

    const result = await scanArchitecture(tmpDir, [project]);

    expect(result.archetype).toBe('express');
    expect(result.layers.length).toBeGreaterThan(0);
    expect(result.totalClassified).toBeGreaterThan(0);

    // Should have routing, middleware, services, domain, data-access, config, shared, testing
    const layerNames = result.layers.map((l) => l.layer);
    expect(layerNames).toContain('routing');
    expect(layerNames).toContain('middleware');
    expect(layerNames).toContain('services');
    expect(layerNames).toContain('domain');
    expect(layerNames).toContain('config');
    expect(layerNames).toContain('testing');
    await cleanupDir(tmpDir);
  });

  // ── .NET classification ──

  it('classifies a .NET solution layout into layers', async () => {
    await createFiles(tmpDir, [
      'src/Bridge.Domain/Orders/Order.cs',
      'src/Bridge.WebApi/Controllers/OrdersController.cs',
      'src/Bridge.WebApi/Program.cs',
      'src/Bridge.Database/Migrations/20240101_Init.cs',
      'src/Bridge.Services/OrderService.cs',
      'src/Bridge.Infrastructure/Queue/BusClient.cs',
      'src/Bridge.WebApp/Views/Home/Index.cshtml',
      'tests/Bridge.Worker.Tests/OrderServiceTests.cs',
    ]);
    const dotnetProject: ProjectScan = { ...makeProject([]), type: 'dotnet' };
    const result = await scanArchitecture(tmpDir, [dotnetProject]);

    const byLayer = (name: string) => result.layers.find((l) => l.layer === name);
    expect(byLayer('domain')).toBeDefined();          // Orders/ under Domain project
    expect(byLayer('routing')).toBeDefined();         // Controllers/ + *Controller.cs
    expect(byLayer('config')).toBeDefined();          // Program.cs
    expect(byLayer('data-access')).toBeDefined();     // Migrations/
    expect(byLayer('services')).toBeDefined();        // *Service.cs
    expect(byLayer('infrastructure')).toBeDefined();  // Queue/
    expect(byLayer('presentation')).toBeDefined();    // Views/ .cshtml
    expect(byLayer('testing')).toBeDefined();         // *.Tests/ + *Tests.cs
    await cleanupDir(tmpDir);
  });

  it('classifies PascalCase directories case-insensitively', async () => {
    await createFiles(tmpDir, [
      'MyApp/Controllers/HomeController.cs',
      'MyApp/Models/Product.cs',
      'MyApp/Services/Billing.cs',
    ]);
    const result = await scanArchitecture(tmpDir, [makeProject([])]);
    expect(result.layers.find((l) => l.layer === 'routing')).toBeDefined();
    expect(result.layers.find((l) => l.layer === 'domain')).toBeDefined();
    expect(result.layers.find((l) => l.layer === 'services')).toBeDefined();
    await cleanupDir(tmpDir);
  });

  it('matches top-level conventional directories without a leading slash', async () => {
    await createFiles(tmpDir, ['tests/unit/helpers.cs', 'controllers/api.cs']);
    const result = await scanArchitecture(tmpDir, [makeProject([])]);
    expect(result.layers.find((l) => l.layer === 'testing')?.fileCount).toBe(1);
    expect(result.layers.find((l) => l.layer === 'routing')?.fileCount).toBe(1);
    await cleanupDir(tmpDir);
  });

  it('maps NuGet packages to layers', async () => {
    await createFiles(tmpDir, ['src/App/Program.cs']);
    const project: ProjectScan = {
      ...makeProject([
        makeDep('Microsoft.EntityFrameworkCore', '8.0.0'),
        makeDep('Serilog', '3.1.0'),
        makeDep('xunit', '2.6.0'),
      ]),
      type: 'dotnet',
    };
    const result = await scanArchitecture(tmpDir, [project]);
    const da = result.layers.find((l) => l.layer === 'data-access');
    expect(da?.packages.some((p) => p.name === 'Microsoft.EntityFrameworkCore')).toBe(true);
    const infra = result.layers.find((l) => l.layer === 'infrastructure');
    expect(infra?.packages.some((p) => p.name === 'Serilog')).toBe(true);
    const testing = result.layers.find((l) => l.layer === 'testing');
    expect(testing?.packages.some((p) => p.name === 'xunit')).toBe(true);
    await cleanupDir(tmpDir);
  });

  it('ignores bin and obj directories', async () => {
    await createFiles(tmpDir, [
      'src/App/Program.cs',
      'src/App/bin/Debug/App.cs',
      'src/App/obj/Generated.cs',
    ]);
    const result = await scanArchitecture(tmpDir, [makeProject([])]);
    expect(result.totalClassified + result.unclassified).toBe(1);
    await cleanupDir(tmpDir);
  });

  // ── Other-language classification (Java, Python, Go, Ruby, Swift, Dart, Elixir, PHP) ──

  it('classifies a Java Maven/Spring layout into layers', async () => {
    await createFiles(tmpDir, [
      'src/main/java/com/acme/controller/UserController.java',
      'src/main/java/com/acme/service/UserServiceImpl.java',
      'src/main/java/com/acme/model/User.java',
      'src/main/java/com/acme/repository/UserRepository.java',
      'src/main/java/com/acme/config/AppConfiguration.java',
      'src/test/java/com/acme/UserControllerTest.java',
    ]);
    const project: ProjectScan = { ...makeProject([]), type: 'java' };
    const result = await scanArchitecture(tmpDir, [project]);
    const byLayer = (name: string) => result.layers.find((l) => l.layer === name);
    expect(byLayer('routing')).toBeDefined();
    expect(byLayer('services')).toBeDefined();
    expect(byLayer('domain')).toBeDefined();
    expect(byLayer('data-access')).toBeDefined();
    expect(byLayer('config')).toBeDefined();
    expect(byLayer('testing')).toBeDefined();
    await cleanupDir(tmpDir);
  });

  it('classifies a Django project layout into layers', async () => {
    await createFiles(tmpDir, [
      'shop/models.py',
      'shop/views.py',
      'shop/urls.py',
      'shop/middleware.py',
      'shop/tasks.py',
      'project/settings.py',
      'shop/tests/test_views.py',
    ]);
    const project: ProjectScan = { ...makeProject([]), type: 'python' };
    const result = await scanArchitecture(tmpDir, [project]);
    const byLayer = (name: string) => result.layers.find((l) => l.layer === name);
    expect(byLayer('domain')).toBeDefined();
    expect(byLayer('routing')).toBeDefined();
    expect(byLayer('middleware')).toBeDefined();
    expect(byLayer('services')).toBeDefined();
    expect(byLayer('config')).toBeDefined();
    expect(byLayer('testing')).toBeDefined();
    await cleanupDir(tmpDir);
  });

  it('classifies a Go service layout into layers', async () => {
    await createFiles(tmpDir, [
      'cmd/server/main.go',
      'internal/handlers/user.go',
      'internal/middleware/auth.go',
      'internal/repositories/user.go',
      'internal/handlers/user_test.go',
    ]);
    const project: ProjectScan = { ...makeProject([]), type: 'go' };
    const result = await scanArchitecture(tmpDir, [project]);
    const byLayer = (name: string) => result.layers.find((l) => l.layer === name);
    expect(byLayer('routing')).toBeDefined();       // cmd/ + handlers/
    expect(byLayer('middleware')).toBeDefined();
    expect(byLayer('data-access')).toBeDefined();
    expect(byLayer('testing')).toBeDefined();       // _test.go
    await cleanupDir(tmpDir);
  });

  it('classifies a Rails app layout into layers', async () => {
    await createFiles(tmpDir, [
      'app/controllers/users_controller.rb',
      'app/models/user.rb',
      'app/views/users/index.html.erb',
      'app/mailers/user_mailer.rb',
      'db/migrate/20240101_create_users.rb',
      'spec/models/user_spec.rb',
    ]);
    const project: ProjectScan = { ...makeProject([]), type: 'ruby' };
    const result = await scanArchitecture(tmpDir, [project]);
    const byLayer = (name: string) => result.layers.find((l) => l.layer === name);
    expect(byLayer('routing')).toBeDefined();        // controllers/
    expect(byLayer('domain')).toBeDefined();         // models/
    expect(byLayer('presentation')).toBeDefined();   // views/ .erb
    expect(byLayer('infrastructure')).toBeDefined(); // mailers/
    expect(byLayer('data-access')).toBeDefined();    // db/migrate/
    expect(byLayer('testing')).toBeDefined();        // spec/ + _spec.rb
    await cleanupDir(tmpDir);
  });

  it('classifies Swift and Flutter conventions', async () => {
    await createFiles(tmpDir, [
      'Sources/App/HomeViewController.swift',
      'Tests/AppTests/HomeTests.swift',
      'lib/screens/home_screen.dart',
      'lib/widgets/button.dart',
      'test/home_test.dart',
    ]);
    const result = await scanArchitecture(tmpDir, [makeProject([])]);
    const pres = result.layers.find((l) => l.layer === 'presentation');
    expect(pres).toBeDefined(); // ViewController + screens/ + widgets/
    expect(pres!.fileCount).toBeGreaterThanOrEqual(3);
    const testing = result.layers.find((l) => l.layer === 'testing');
    expect(testing).toBeDefined(); // Tests/ + *Tests.swift + _test.dart
    await cleanupDir(tmpDir);
  });

  it('classifies a Phoenix app layout into layers', async () => {
    await createFiles(tmpDir, [
      'lib/my_app_web/controllers/user_controller.ex',
      'lib/my_app_web/live/user_live.ex',
      'lib/my_app_web/controllers/user_html/index.heex',
      'lib/my_app/repo.ex',
      'test/my_app/user_test.exs',
    ]);
    const project: ProjectScan = { ...makeProject([]), type: 'elixir' };
    const result = await scanArchitecture(tmpDir, [project]);
    const byLayer = (name: string) => result.layers.find((l) => l.layer === name);
    expect(byLayer('routing')).toBeDefined();       // _controller.ex + controllers/
    expect(byLayer('presentation')).toBeDefined();  // _live.ex + .heex
    expect(byLayer('data-access')).toBeDefined();   // repo.ex
    expect(byLayer('testing')).toBeDefined();       // _test.exs
    await cleanupDir(tmpDir);
  });

  it('classifies a Laravel app layout into layers', async () => {
    await createFiles(tmpDir, [
      'app/Http/Controllers/UserController.php',
      'app/Http/Middleware/Authenticate.php',
      'app/Models/User.php',
      'resources/views/home.blade.php',
      'database/migrations/2024_01_01_create_users.php',
    ]);
    const project: ProjectScan = { ...makeProject([]), type: 'php' };
    const result = await scanArchitecture(tmpDir, [project]);
    const byLayer = (name: string) => result.layers.find((l) => l.layer === name);
    expect(byLayer('routing')).toBeDefined();
    expect(byLayer('middleware')).toBeDefined();
    expect(byLayer('domain')).toBeDefined();
    expect(byLayer('presentation')).toBeDefined();
    expect(byLayer('data-access')).toBeDefined();
    await cleanupDir(tmpDir);
  });

  it('maps non-JS ecosystem packages to layers', async () => {
    await createFiles(tmpDir, ['src/app.py']);
    const project: ProjectScan = {
      ...makeProject([
        makeDep('sqlalchemy', '2.0.0'),
        makeDep('org.springframework.boot:spring-boot-starter-web', '3.2.0'),
        makeDep('gorm.io/gorm', '1.25.0'),
        makeDep('phoenix', '1.7.0'),
      ]),
      type: 'python',
    };
    const result = await scanArchitecture(tmpDir, [project]);
    const da = result.layers.find((l) => l.layer === 'data-access');
    expect(da?.packages.some((p) => p.name === 'sqlalchemy')).toBe(true);
    expect(da?.packages.some((p) => p.name === 'gorm.io/gorm')).toBe(true);
    const routing = result.layers.find((l) => l.layer === 'routing');
    expect(routing?.packages.some((p) => p.name === 'org.springframework.boot:spring-boot-starter-web')).toBe(true);
    expect(routing?.packages.some((p) => p.name === 'phoenix')).toBe(true);
    await cleanupDir(tmpDir);
  });

  it('builds a project-level mermaid architecture diagram', async () => {
    await createFiles(tmpDir, [
      'src/components/Button.tsx',
      'src/routes/users.ts',
      'src/services/user.service.ts',
    ]);
    const project = makeProject([makeDep('react', '18.0.0')]);
    const mermaid = await buildProjectArchitectureMermaid(tmpDir, project, 'library');
    expect(mermaid).toContain('flowchart TD');
    expect(mermaid).toContain('Presentation');
    expect(mermaid).toContain('Routing');
    expect(mermaid).toContain('Services');
    await cleanupDir(tmpDir);
  });

  it('builds project-level diagrams from project path in monorepos', async () => {
    await createFiles(tmpDir, [
      'packages/web/src/components/Header.tsx',
      'packages/api/src/routes/health.ts',
    ]);

    const webProject: ProjectScan = {
      ...makeProject([makeDep('react', '18.0.0')], 'web'),
      path: 'packages/web',
    };

    const apiProject: ProjectScan = {
      ...makeProject([makeDep('express', '4.18.0')], 'api'),
      path: 'packages/api',
    };

    const webMermaid = await buildProjectArchitectureMermaid(tmpDir, webProject, 'library');
    const apiMermaid = await buildProjectArchitectureMermaid(tmpDir, apiProject, 'express');

    expect(webMermaid).toContain('Presentation');
    expect(webMermaid).not.toContain('Routing');
    expect(apiMermaid).toContain('Routing');
    expect(apiMermaid).not.toContain('Presentation');

    await cleanupDir(tmpDir);
  });

});
