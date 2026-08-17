// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import { evidenceOf } from '../fusion.js';
import type { ArchitectureKnowledgePack, ProjectContext } from '../types.js';
import { hasExt, hasPackage, typeIs } from './helpers.js';

export const platformPacks: ArchitectureKnowledgePack[] = [
  {
    id: 'platform/web',
    platforms: ['web'],
    match(ctx: ProjectContext) {
      const dep = hasPackage(ctx, 'react', 'vue', 'svelte', 'next', 'nuxt', '@angular/core');
      if (!dep && !hasExt(ctx, '.tsx', '.jsx', '.vue', '.svelte', '.cshtml', '.razor')) return [];
      return [evidenceOf('platform/web', 'platform', 'web', dep ? 0.85 : 0.65, dep ? ['web-dependency'] : ['web-extension'])];
    },
  },
  {
    id: 'platform/jvm',
    platforms: ['jvm'],
    match(ctx: ProjectContext) {
      if (!typeIs(ctx, 'java', 'kotlin', 'scala', 'groovy') && !hasExt(ctx, '.java', '.kt', '.kts', '.scala', '.groovy')) return [];
      return [evidenceOf('platform/jvm', 'platform', 'jvm', 0.9, [`type:${ctx.projectType}`])];
    },
  },
  {
    id: 'platform/dotnet',
    platforms: ['dotnet'],
    match(ctx: ProjectContext) {
      if (!typeIs(ctx, 'dotnet') && !hasExt(ctx, '.cs', '.fs', '.vb', '.cshtml', '.razor')) return [];
      return [evidenceOf('platform/dotnet', 'platform', 'dotnet', 0.9, [`type:${ctx.projectType}`])];
    },
  },
  {
    id: 'platform/mainframe',
    platforms: ['mainframe'],
    match(ctx: ProjectContext) {
      if (!typeIs(ctx, 'cobol', 'rpg', 'fortran', 'pascal', 'ada', 'visual-basic')) return [];
      return [evidenceOf('platform/mainframe', 'platform', 'mainframe', 0.9, [`type:${ctx.projectType}`])];
    },
  },
];
