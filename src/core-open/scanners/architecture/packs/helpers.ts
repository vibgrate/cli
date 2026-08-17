// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import type { ProjectContext } from '../types.js';

export function hasExt(ctx: ProjectContext, ...exts: string[]): boolean {
  return exts.some((e) => ctx.extensions.has(e));
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
