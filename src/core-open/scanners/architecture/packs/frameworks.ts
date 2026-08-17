// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import { evidenceOf } from '../fusion.js';
import type { ArchitectureKnowledgePack, AstRoleQuery, ProjectContext } from '../types.js';
import {
  DJANGO_AST_ROLES,
  FASTAPI_AST_ROLES,
  NESTJS_AST_ROLES,
  SPRING_AST_ROLES,
  DOTNET_AST_ROLES,
} from './ast-role-catalog.js';
import { filePathHas, hasFile, hasPackage, packageHas, typeIs } from './helpers.js';

function depFramework(
  id: string,
  value: string,
  packages: readonly string[],
  extra?: (ctx: ProjectContext) => string[],
  astRoles?: readonly AstRoleQuery[],
): ArchitectureKnowledgePack {
  return {
    id,
    frameworks: [value],
    astRoles,
    match(ctx: ProjectContext) {
      const hit = packages.filter((p) => ctx.packages.has(p));
      const extraSignals = extra?.(ctx) ?? [];
      if (hit.length === 0 && extraSignals.length === 0) return [];
      const signals = [...hit.map((p) => `dep:${p}`), ...extraSignals];
      const confidence = hit.length > 0 ? Math.min(0.7 + hit.length * 0.1, 0.95) : 0.7;
      return [evidenceOf(id, 'framework', value, confidence, signals)];
    },
  };
}

export const frameworkPacks: ArchitectureKnowledgePack[] = [
  depFramework('framework/nextjs', 'nextjs', ['next', '@next/core'], (ctx) => {
    const s: string[] = [];
    if (hasFile(ctx, 'next.config.js', 'next.config.ts', 'next.config.mjs')) s.push('next-config');
    if (filePathHas(ctx, /(^|\/)app\/.*page\.[jt]sx?$/)) s.push('app-router');
    return s;
  }),
  depFramework(
    'framework/nestjs',
    'nestjs',
    ['@nestjs/core', '@nestjs/common'],
    (ctx) => (filePathHas(ctx, /\.controller\.[jt]sx?$/) ? ['controller-suffix'] : []),
    NESTJS_AST_ROLES,
  ),
  depFramework('framework/express', 'express', ['express']),
  depFramework('framework/remix', 'remix', ['@remix-run/react', '@remix-run/node', '@remix-run/dev']),
  depFramework('framework/sveltekit', 'sveltekit', ['@sveltejs/kit']),
  depFramework('framework/nuxt', 'nuxt', ['nuxt']),
  depFramework('framework/fastify', 'fastify', ['fastify']),
  depFramework('framework/hono', 'hono', ['hono']),
  depFramework('framework/koa', 'koa', ['koa']),
  depFramework('framework/serverless', 'serverless', [
    'serverless', 'aws-lambda', '@aws-sdk/client-lambda', 'middy', '@cloudflare/workers-types',
  ]),
  {
    id: 'framework/spring',
    frameworks: ['spring'],
    astRoles: SPRING_AST_ROLES,
    match(ctx: ProjectContext) {
      const springDep = packageHas(ctx, (p) =>
        p.includes('springframework') || p.includes('spring-boot') || p.startsWith('org.springframework'),
      );
      const layout = filePathHas(ctx, /\/controller\//) && (typeIs(ctx, 'java', 'kotlin', 'groovy') || filePathHas(ctx, /Application\.java$/));
      if (!springDep && !layout) return [];
      const signals: string[] = [];
      if (springDep) signals.push('spring-dependency');
      if (layout) signals.push('spring-layout');
      return [evidenceOf('framework/spring', 'framework', 'spring', springDep ? 0.92 : 0.72, signals)];
    },
  },
  {
    id: 'framework/aspnet',
    frameworks: ['aspnet'],
    astRoles: DOTNET_AST_ROLES,
    match(ctx: ProjectContext) {
      const aspDep = packageHas(ctx, (p) =>
        p.toLowerCase().includes('microsoft.aspnetcore') || p.toLowerCase() === 'swashbuckle.aspnetcore',
      );
      const webLayout = typeIs(ctx, 'dotnet') && (
        filePathHas(ctx, /\/controllers\//i) || filePathHas(ctx, /\/program\.cs$/i)
      );
      if (!aspDep && !webLayout) return [];
      const signals: string[] = [];
      if (aspDep) signals.push('aspnet-dependency');
      if (webLayout) signals.push('aspnet-layout');
      // Layout-only (Program.cs) is a weak prior — a class library also has Program.cs rarely, but
      // Controllers/ plus type=dotnet is enough for Level 2 without claiming a full ASP.NET host.
      return [evidenceOf('framework/aspnet', 'framework', 'aspnet', aspDep ? 0.92 : 0.7, signals)];
    },
  },
  {
    id: 'framework/django',
    frameworks: ['django'],
    astRoles: DJANGO_AST_ROLES,
    match(ctx: ProjectContext) {
      const dep = hasPackage(ctx, 'django');
      const layout = hasFile(ctx, 'urls.py', 'wsgi.py', 'asgi.py', 'manage.py') ||
        (hasFile(ctx, 'models.py') && hasFile(ctx, 'views.py'));
      if (!dep && !layout) return [];
      const signals: string[] = [];
      if (dep) signals.push('dep:django');
      if (layout) signals.push('django-layout');
      return [evidenceOf('framework/django', 'framework', 'django', dep ? 0.93 : 0.78, signals)];
    },
  },
  {
    id: 'framework/fastapi',
    frameworks: ['fastapi'],
    astRoles: FASTAPI_AST_ROLES,
    match(ctx: ProjectContext) {
      const dep = hasPackage(ctx, 'fastapi', 'starlette');
      const layout = typeIs(ctx, 'python') && filePathHas(ctx, /(^|\/)api\/routes\//);
      if (!dep && !layout) return [];
      const signals: string[] = [];
      if (dep) signals.push('dep:fastapi');
      if (layout) signals.push('fastapi-layout');
      return [evidenceOf('framework/fastapi', 'framework', 'fastapi', dep ? 0.93 : 0.7, signals)];
    },
  },
  {
    id: 'framework/rails',
    frameworks: ['rails'],
    match(ctx: ProjectContext) {
      const dep = hasPackage(ctx, 'rails', 'railties', 'actionpack');
      const layout = filePathHas(ctx, /(^|\/)app\/controllers\//) && (hasFile(ctx, 'gemfile') || filePathHas(ctx, /(^|\/)config\/routes\.rb$/));
      if (!dep && !layout) return [];
      const signals: string[] = [];
      if (dep) signals.push('dep:rails');
      if (layout) signals.push('rails-layout');
      return [evidenceOf('framework/rails', 'framework', 'rails', dep ? 0.93 : 0.8, signals)];
    },
  },
  {
    id: 'framework/laravel',
    frameworks: ['laravel'],
    match(ctx: ProjectContext) {
      const dep = hasPackage(ctx, 'laravel/framework');
      const layout = typeIs(ctx, 'php') && (
        filePathHas(ctx, /(^|\/)app\/http\/controllers\//i) || hasFile(ctx, 'artisan')
      );
      if (!dep && !layout) return [];
      const signals: string[] = [];
      if (dep) signals.push('dep:laravel/framework');
      if (layout) signals.push('laravel-layout');
      return [evidenceOf('framework/laravel', 'framework', 'laravel', dep ? 0.93 : 0.78, signals)];
    },
  },
  {
    id: 'framework/phoenix',
    frameworks: ['phoenix'],
    match(ctx: ProjectContext) {
      const dep = hasPackage(ctx, 'phoenix', 'phoenix_live_view');
      const layout = typeIs(ctx, 'elixir') && filePathHas(ctx, /_controller\.exs?$/);
      if (!dep && !layout) return [];
      const signals: string[] = [];
      if (dep) signals.push('dep:phoenix');
      if (layout) signals.push('phoenix-layout');
      return [evidenceOf('framework/phoenix', 'framework', 'phoenix', dep ? 0.93 : 0.78, signals)];
    },
  },
];
