// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import type { ProjectContext } from '../types.js';

export function hasExt(ctx: ProjectContext, ...exts: string[]): boolean {
  return exts.some((e) => ctx.extensions.has(e));
}

/** Project folder + package name, used as a kind signal not a file layer. */
export function projectNameHaystack(ctx: ProjectContext): string {
  return `${ctx.projectPath.replace(/\\/g, '/')}/${ctx.project.name ?? ''}`;
}

/** `WebApp`, `Frontend`, or a delimited `Spa` segment — not a per-file layer. */
export function looksLikeWebAppName(ctx: ProjectContext): boolean {
  return /webapp|frontend|(?:^|[/._-])spa(?:[/._-]|$)/i.test(projectNameHaystack(ctx));
}

/** Delimited `Client` segment. Too weak alone — pair with a UI signal. */
export function looksLikeClientName(ctx: ProjectContext): boolean {
  return /(?:^|[/._-])client(?:[/._-]|$)/i.test(projectNameHaystack(ctx));
}

const SPA_UI_PACKAGES = [
  'react', 'vue', 'svelte', '@angular/core',
  'vue-router', 'vuetify', '@vitejs/plugin-vue',
  'react-router', 'react-router-dom', '@angular/router',
] as const;

export function hasSpaUiSignal(ctx: ProjectContext): boolean {
  return hasPackage(ctx, ...SPA_UI_PACKAGES) || hasExt(ctx, '.vue', '.svelte');
}

export function hasFile(ctx: ProjectContext, ...names: string[]): boolean {
  return names.some((n) => ctx.fileNames.has(n.toLowerCase()));
}

export function hasPackage(ctx: ProjectContext, ...names: string[]): boolean {
  return names.some((n) => ctx.packages.has(n));
}

export function packageHas(ctx: ProjectContext, pred: (name: string) => boolean): boolean {
  for (const p of ctx.packages) {
    if (pred(p)) return true;
  }
  return false;
}

export function filePathHas(ctx: ProjectContext, re: RegExp): boolean {
  return ctx.files.some((f) => re.test(f.replace(/\\/g, '/')));
}

export function typeIs(ctx: ProjectContext, ...types: string[]): boolean {
  return types.includes(ctx.projectType);
}
