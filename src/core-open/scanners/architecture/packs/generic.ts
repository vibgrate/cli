// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import { evidenceOf } from '../fusion.js';
import type { ArchitectureKnowledgePack, ProjectContext } from '../types.js';
import { hasExt } from './helpers.js';

/**
 * Shared testing / config / source priors. Always eligible so existing
 * layer rules still fire even when no framework pack matches.
 */
export const genericSourcePack: ArchitectureKnowledgePack = {
  id: 'generic/source',
  match(ctx: ProjectContext) {
    if (ctx.files.length === 0 && !ctx.project.name) {
      return [evidenceOf('generic/source', 'artifactKind', 'source', 0.41, ['empty-tree'])];
    }
    if (ctx.files.length === 0) {
      return [evidenceOf('generic/source', 'artifactKind', 'source', 0.41, ['project-manifest'])];
    }
    const sourceExt = hasExt(
      ctx,
      '.ts', '.tsx', '.js', '.jsx', '.cs', '.java', '.py', '.go', '.rb', '.php',
      '.kt', '.scala', '.ex', '.rs', '.swift', '.dart', '.fs', '.vb',
    );
    if (!sourceExt) return [];
    return [evidenceOf('generic/source', 'artifactKind', 'source', 0.5, ['source-extension'])];
  },
};
