// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import { evidenceOf } from '../fusion.js';
import type { ArchitectureKnowledgePack, ProjectContext } from '../types.js';
import { hasFile, typeIs } from './helpers.js';

export const buildPacks: ArchitectureKnowledgePack[] = [
  {
    id: 'build/npm',
    buildSystems: ['npm'],
    match(ctx: ProjectContext) {
      if (!typeIs(ctx, 'node', 'typescript') && !hasFile(ctx, 'package.json')) return [];
      return [evidenceOf('build/npm', 'buildSystem', 'npm', 0.85, typeIs(ctx, 'node', 'typescript') ? ['type:node'] : ['package.json'])];
    },
  },
  {
    id: 'build/msbuild',
    buildSystems: ['msbuild'],
    extensions: ['.csproj', '.fsproj', '.vbproj', '.sln'],
    match(ctx: ProjectContext) {
      const csproj = [...ctx.fileNames].some((n) => n.endsWith('.csproj') || n.endsWith('.fsproj') || n.endsWith('.vbproj') || n.endsWith('.sln'));
      if (!typeIs(ctx, 'dotnet') && !csproj) return [];
      return [evidenceOf('build/msbuild', 'buildSystem', 'msbuild', 0.9, typeIs(ctx, 'dotnet') ? ['type:dotnet'] : ['msbuild-proj'])];
    },
  },
  {
    id: 'build/gradle',
    buildSystems: ['gradle'],
    match(ctx: ProjectContext) {
      if (!hasFile(ctx, 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts')) return [];
      return [evidenceOf('build/gradle', 'buildSystem', 'gradle', 0.92, ['gradle-manifest'])];
    },
  },
  {
    id: 'build/maven',
    buildSystems: ['maven'],
    match(ctx: ProjectContext) {
      if (!hasFile(ctx, 'pom.xml')) return [];
      return [evidenceOf('build/maven', 'buildSystem', 'maven', 0.92, ['pom.xml'])];
    },
  },
  {
    id: 'build/go-mod',
    buildSystems: ['go-mod'],
    match(ctx: ProjectContext) {
      if (!typeIs(ctx, 'go') && !hasFile(ctx, 'go.mod')) return [];
      return [evidenceOf('build/go-mod', 'buildSystem', 'go-mod', 0.9, typeIs(ctx, 'go') ? ['type:go'] : ['go.mod'])];
    },
  },
  {
    id: 'build/pip',
    buildSystems: ['pip'],
    match(ctx: ProjectContext) {
      if (!typeIs(ctx, 'python') && !hasFile(ctx, 'pyproject.toml', 'requirements.txt', 'setup.py', 'pipfile')) return [];
      return [evidenceOf('build/pip', 'buildSystem', 'pip', 0.85, typeIs(ctx, 'python') ? ['type:python'] : ['python-manifest'])];
    },
  },
];
