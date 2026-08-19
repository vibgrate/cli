// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import { evidenceOf } from '../fusion.js';
import { isApplicationSourceFile, isContractBasename, isContractExtension, isIacExtension } from '../walker.js';
import type { ArchitectureEvidence, ArchitectureKnowledgePack, ProjectContext } from '../types.js';
import {
  filePathHas,
  hasExt,
  hasFile,
  hasPackage,
  hasSpaUiSignal,
  looksLikeClientName,
  looksLikeWebAppName,
  packageHas,
  typeIs,
} from './helpers.js';

function contractFiles(ctx: ProjectContext): string[] {
  const hits: string[] = [];
  for (const f of ctx.files) {
    const base = f.replace(/\\/g, '/').split('/').pop() ?? f;
    const ext = (() => {
      const i = f.lastIndexOf('.');
      return i >= 0 ? f.slice(i).toLowerCase() : '';
    })();
    if (isContractExtension(ext) || isContractBasename(base)) hits.push(f);
  }
  return hits;
}

function iacFiles(ctx: ProjectContext): string[] {
  return ctx.files.filter((f) => {
    const i = f.lastIndexOf('.');
    return i >= 0 && isIacExtension(f.slice(i));
  });
}

export const projectKindPacks: ArchitectureKnowledgePack[] = [
  {
    id: 'project-kind/contract',
    projectKinds: ['contract'],
    extensions: ['.proto', '.graphql', '.gql', '.avsc'],
    match(ctx: ProjectContext) {
      const files = contractFiles(ctx);
      const named = ctx.projectPath === 'proto' || /(^|\/)(proto|contracts|api-specs?)(\/|$)/.test(ctx.projectPath.replace(/\\/g, '/'));
      if (files.length === 0 && !named) return [];
      // Dedicated contract tree: no application source. Build manifests
      // (package.json, go.mod, …) are not source.
      const sourceCount = ctx.files.filter((f) => isApplicationSourceFile(f)).length;
      const dedicated = named || (files.length > 0 && sourceCount === 0);
      if (!dedicated) return [];
      const out: ArchitectureEvidence[] = [
        evidenceOf('project-kind/contract', 'projectKind', 'contract', 0.92, named ? ['contract-path'] : ['contract-files']),
      ];
      const sample = files[0];
      if (sample) {
        const base = sample.replace(/\\/g, '/').split('/').pop() ?? sample;
        const ext = (() => {
          const i = sample.lastIndexOf('.');
          return i >= 0 ? sample.slice(i).toLowerCase() : '';
        })();
        const kind = isContractBasename(base)
          ? (base.toLowerCase().startsWith('asyncapi') ? 'asyncapi' : 'openapi')
          : ext === '.proto' ? 'protobuf'
            : ext === '.graphql' || ext === '.gql' ? 'graphql'
              : ext === '.avsc' ? 'avro'
                : undefined;
        if (kind) {
          out.push(evidenceOf('project-kind/contract', 'artifactKind', 'contract', 0.93, [`kind:${kind}`]));
        }
      }
      return out;
    },
  },
  {
    id: 'project-kind/iac',
    projectKinds: ['iac'],
    extensions: ['.tf', '.tfvars', '.hcl', '.bicep'],
    match(ctx: ProjectContext) {
      const files = iacFiles(ctx);
      const typeHit = typeIs(ctx, 'terraform', 'helm');
      const named = /(^|\/)(infra|infrastructure|terraform|iac)(\/|$)/.test(ctx.projectPath.replace(/\\/g, '/'));
      if (files.length === 0 && !typeHit && !named) return [];
      const sourceish = ctx.files.filter((f) => isApplicationSourceFile(f));
      // Application-layer adapters (src/infra/s3.ts) keep the app projectKind.
      if (!typeHit && sourceish.length > files.length) return [];
      const signals: string[] = [];
      if (typeHit) signals.push(`type:${ctx.projectType}`);
      if (files.length) signals.push('iac-extension');
      if (named) signals.push('iac-path');
      return [
        evidenceOf('project-kind/iac', 'projectKind', 'iac', typeHit || files.length > 0 ? 0.93 : 0.7, signals),
        evidenceOf('project-kind/iac', 'artifactKind', 'infrastructure-definition', 0.93, signals),
      ];
    },
  },
  {
    id: 'project-kind/database',
    projectKinds: ['database'],
    match(ctx: ProjectContext) {
      const prisma = filePathHas(ctx, /(^|\/)prisma\//) || hasFile(ctx, 'schema.prisma');
      const named = /(^|\/)(database|db)(\/|$)/.test(ctx.projectPath.replace(/\\/g, '/'));
      const prismaPkg = hasPackage(ctx, 'prisma', '@prisma/client');
      if (!prisma && !(named && prismaPkg)) return [];
      const hasAppRoutes = filePathHas(ctx, /(^|\/)(app|pages|controllers|routes)\//);
      if (hasAppRoutes && !named) return [];
      return [evidenceOf('project-kind/database', 'projectKind', 'database', 0.85, prisma ? ['prisma'] : ['database-path'])];
    },
  },
  {
    id: 'project-kind/mainframe',
    projectKinds: ['mainframe'],
    match(ctx: ProjectContext) {
      if (!typeIs(ctx, 'cobol', 'rpg', 'fortran', 'pascal', 'ada', 'visual-basic') &&
          !hasExt(ctx, '.cob', '.cbl', '.ccp', '.rpg', '.rpgle', '.jcl')) {
        return [];
      }
      return [evidenceOf('project-kind/mainframe', 'projectKind', 'mainframe', 0.88, [`type:${ctx.projectType}`])];
    },
  },
  {
    id: 'project-kind/cli',
    projectKinds: ['cli'],
    match(ctx: ProjectContext) {
      const dep = hasPackage(ctx, 'commander', 'yargs', 'meow', 'cac', 'clipanion', 'oclif', 'github.com/spf13/cobra', 'clap');
      const layout = filePathHas(ctx, /(^|\/)commands\//) && !filePathHas(ctx, /(^|\/)(controllers|routes|pages)\//);
      if (!dep && !layout) return [];
      return [evidenceOf('project-kind/cli', 'projectKind', 'cli', dep ? 0.88 : 0.65, dep ? ['cli-dependency'] : ['commands-dir'])];
    },
  },
  {
    id: 'project-kind/worker',
    projectKinds: ['worker'],
    match(ctx: ProjectContext) {
      const dep = hasPackage(ctx, 'bullmq', 'bull', 'celery', 'sidekiq', 'hangfire', 'quartz');
      const named = /(^|\/)(worker|workers|jobs)(\/|$)/.test(ctx.projectPath.replace(/\\/g, '/'));
      const layout = filePathHas(ctx, /(^|\/)(workers|jobs)\//) && !filePathHas(ctx, /(^|\/)(controllers|pages|app\/)\//);
      if (!dep && !named && !layout) return [];
      // A host app that also runs jobs (Rails+Sidekiq, Django+Celery) is
      // not a worker. The job queue is a characteristic, not the kind.
      if (filePathHas(ctx, /(^|\/)(pages|app\/.*page\.|app\/views\/|app\/controllers\/)/)) return [];
      if (hasPackage(ctx, 'rails', 'django', 'laravel', 'next', '@next/core', '@nestjs/core', 'fastapi', 'phoenix')) {
        return [];
      }
      return [evidenceOf('project-kind/worker', 'projectKind', 'worker', dep || named ? 0.8 : 0.62, named ? ['worker-path'] : ['worker-signal'])];
    },
  },
  {
    id: 'project-kind/web-app',
    projectKinds: ['web-app'],
    match(ctx: ProjectContext) {
      const metaFw = hasPackage(ctx, 'next', '@next/core', 'nuxt', '@remix-run/react', '@sveltejs/kit');
      const uiDep = hasPackage(ctx, 'react', 'vue', 'svelte', '@angular/core');
      const spaDeps = hasPackage(ctx, 'vue-router', 'vuetify', '@vitejs/plugin-vue', 'react-router', 'react-router-dom', '@angular/router');
      const vueFiles = hasExt(ctx, '.vue');
      const pages = filePathHas(ctx, /(^|\/)(pages|app\/.*page\.)/);
      const railsViews = filePathHas(ctx, /(^|\/)app\/views\//);
      const libPath = /(^|\/)(packages|libs)(\/|$)/.test(ctx.projectPath.replace(/\\/g, '/'));
      const namedWebApp = looksLikeWebAppName(ctx);
      const clientWithUi = looksLikeClientName(ctx) && (uiDep || spaDeps || vueFiles || pages || railsViews || metaFw);
      const uiWithoutLib = uiDep && !libPath;
      if (!metaFw && !pages && !railsViews && !uiWithoutLib && !namedWebApp && !clientWithUi && !spaDeps && !vueFiles) {
        return [];
      }
      const apiOnly = !metaFw && !railsViews && !namedWebApp && !uiDep && !vueFiles && !spaDeps
        && filePathHas(ctx, /(^|\/)(controllers|routes)\//) && !pages;
      if (apiOnly) return [];
      const signals: string[] = [];
      if (metaFw) signals.push('meta-framework');
      else if (uiDep || spaDeps) signals.push('ui-dependency');
      if (pages || railsViews) signals.push('ui-layout');
      if (namedWebApp) signals.push('webapp-path');
      if (clientWithUi) signals.push('client-path');
      if (vueFiles) signals.push('vue-source');
      const confidence = metaFw || (namedWebApp && (uiDep || spaDeps || vueFiles)) || spaDeps
        ? 0.88
        : namedWebApp || clientWithUi
          ? 0.8
          : 0.72;
      return [evidenceOf('project-kind/web-app', 'projectKind', 'web-app', confidence, signals)];
    },
  },
  {
    id: 'project-kind/web-api',
    projectKinds: ['web-api'],
    match(ctx: ProjectContext) {
      const apiDep = hasPackage(
        ctx,
        'express', 'fastify', 'hono', 'koa', '@nestjs/core',
        'fastapi', 'django', 'flask',
        'github.com/gin-gonic/gin', 'github.com/labstack/echo/v4', 'github.com/go-chi/chi/v5',
      ) || packageHas(ctx, (p) =>
        p.includes('springframework') ||
        p.includes('spring-boot') ||
        p.toLowerCase().includes('microsoft.aspnetcore'),
      );
      // SPA `src/api/` is a browser HTTP client, not HTTP routing. A Vue/React
      // WebApp must not flip to web-api just because that folder exists.
      const spaClient = hasSpaUiSignal(ctx) || looksLikeWebAppName(ctx);
      const layout = spaClient
        ? filePathHas(ctx, /(^|\/)(controllers|routes|handlers)\//)
          || filePathHas(ctx, /\.controller\.[jt]sx?$/)
          || filePathHas(ctx, /Controller\.(cs|java|kt)$/)
        : filePathHas(ctx, /(^|\/)(controllers|routes|handlers|api)\//)
          || filePathHas(ctx, /\.controller\.[jt]sx?$/)
          || filePathHas(ctx, /Controller\.(cs|java|kt)$/);
      if (!apiDep && !layout) return [];
      const signals: string[] = [];
      if (apiDep) signals.push('api-dependency');
      if (layout) signals.push('api-layout');
      return [evidenceOf('project-kind/web-api', 'projectKind', 'web-api', apiDep ? 0.84 : 0.68, signals)];
    },
  },
  {
    id: 'project-kind/library',
    projectKinds: ['library'],
    match(ctx: ProjectContext) {
      const projectPath = ctx.projectPath.replace(/\\/g, '/');
      const named = /(^|\/)(packages|libs|lib)(\/|$)/.test(projectPath);
      const layerNamed = /(^|\/)(domain|application|infrastructure)(\/|$)/i.test(projectPath)
        || /\.(domain|application|infrastructure)\//i.test(projectPath);
      const noApp = !filePathHas(ctx, /(^|\/)(controllers|routes|pages|app\/.*page\.)/)
        && !filePathHas(ctx, /Controller\.(cs|java|kt)$/);
      const jsLib = typeIs(ctx, 'node', 'typescript') && noApp && !hasPackage(ctx, 'express', 'next', '@nestjs/core', 'fastify', 'commander');
      const compiledLib = typeIs(ctx, 'dotnet', 'java', 'kotlin', 'scala', 'groovy') && noApp;
      if (!named && !jsLib && !compiledLib && !layerNamed) return [];
      // A Controllers/ tree is not a library even under packages/.
      if (!noApp) return [];
      const signal = named ? 'packages-path' : layerNamed ? 'layer-project' : 'no-app-surface';
      const confidence = named || layerNamed ? 0.72 : compiledLib ? 0.62 : 0.55;
      return [evidenceOf('project-kind/library', 'projectKind', 'library', confidence, [signal])];
    },
  },
];
