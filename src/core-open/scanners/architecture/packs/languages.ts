// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import { evidenceOf } from '../fusion.js';
import type { ArchitectureKnowledgePack, ProjectContext } from '../types.js';
import { DOTNET_AST_ROLES, GO_AST_ROLES, JAVA_AST_ROLES } from './ast-role-catalog.js';
import { hasExt, typeIs } from './helpers.js';

function lang(
  id: string,
  value: string,
  types: readonly string[],
  exts: readonly string[],
): ArchitectureKnowledgePack {
  return {
    id,
    languages: [value],
    extensions: exts,
    match(ctx: ProjectContext) {
      const byType = typeIs(ctx, ...types);
      const byExt = hasExt(ctx, ...exts);
      if (!byType && !byExt) return [];
      const signals: string[] = [];
      if (byType) signals.push(`type:${ctx.projectType}`);
      if (byExt) signals.push('extension');
      return [evidenceOf(id, 'language', value, byType ? 0.9 : 0.75, signals)];
    },
  };
}

const tsPack: ArchitectureKnowledgePack = {
  id: 'language/ts',
  languages: ['typescript'],
  extensions: ['.ts', '.tsx', '.mts', '.cts'],
  match(ctx: ProjectContext) {
    const byType = typeIs(ctx, 'typescript');
    const byExt = hasExt(ctx, '.ts', '.tsx', '.mts', '.cts');
    if (!byType && !byExt) return [];
    const signals: string[] = [];
    if (byType) signals.push('type:typescript');
    if (byExt) signals.push('extension');
    return [evidenceOf('language/ts', 'language', 'typescript', byType ? 0.9 : 0.8, signals)];
  },
};

const jsPack: ArchitectureKnowledgePack = {
  id: 'language/js',
  languages: ['javascript'],
  extensions: ['.js', '.jsx', '.mjs', '.cjs'],
  match(ctx: ProjectContext) {
    const byExt = hasExt(ctx, '.js', '.jsx', '.mjs', '.cjs');
    const hasTs = hasExt(ctx, '.ts', '.tsx', '.mts', '.cts') || typeIs(ctx, 'typescript');
    // Do not claim JS when TypeScript sources (or a typescript project type) are present.
    if (hasTs) return [];
    if (!byExt && !typeIs(ctx, 'node')) return [];
    if (!byExt && typeIs(ctx, 'node')) {
      return [evidenceOf('language/js', 'language', 'javascript', 0.55, ['type:node'])];
    }
    return [evidenceOf('language/js', 'language', 'javascript', 0.8, ['extension'])];
  },
};

export const languagePacks: ArchitectureKnowledgePack[] = [
  tsPack,
  jsPack,
  { ...lang('language/cs', 'csharp', ['dotnet'], ['.cs']), astRoles: DOTNET_AST_ROLES },
  { ...lang('language/java', 'java', ['java'], ['.java']), astRoles: JAVA_AST_ROLES },
  lang('language/python', 'python', ['python'], ['.py', '.pyi']),
  { ...lang('language/go', 'go', ['go'], ['.go']), astRoles: GO_AST_ROLES },
  lang('language/php', 'php', ['php'], ['.php']),
  lang('language/ruby', 'ruby', ['ruby'], ['.rb', '.rake', '.erb']),
  lang('language/elixir', 'elixir', ['elixir'], ['.ex', '.exs', '.eex', '.heex']),
  lang('language/kotlin', 'kotlin', ['kotlin'], ['.kt', '.kts']),
  lang('language/scala', 'scala', ['scala'], ['.scala']),
  lang('language/groovy', 'groovy', ['groovy'], ['.groovy']),
  lang('language/rust', 'rust', ['rust'], ['.rs']),
  lang('language/swift', 'swift', ['swift'], ['.swift']),
  lang('language/dart', 'dart', ['dart'], ['.dart']),
];
