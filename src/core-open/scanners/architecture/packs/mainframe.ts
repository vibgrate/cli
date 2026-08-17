// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import { evidenceOf } from '../fusion.js';
import type { ArchitectureKnowledgePack, ProjectContext } from '../types.js';
import { hasExt, typeIs } from './helpers.js';

/**
 * Mainframe first-wave: Level 1–2 path / suffix / projectKind only.
 * No COBOL AST, no graph confirmation.
 */
export const mainframePack: ArchitectureKnowledgePack = {
  id: 'language/cobol',
  languages: ['cobol'],
  projectKinds: ['mainframe'],
  platforms: ['mainframe'],
  extensions: ['.cob', '.cbl', '.ccp', '.cpy', '.rpg', '.rpgle', '.jcl', '.sql', '.f', '.f90', '.for', '.pas', '.pp', '.ada', '.adb', '.ads', '.bas'],
  match(ctx: ProjectContext) {
    const cobol = typeIs(ctx, 'cobol') || hasExt(ctx, '.cob', '.cbl', '.ccp', '.cpy');
    if (!cobol) return [];
    return [
      evidenceOf('language/cobol', 'language', 'cobol', 0.9, [`type:${ctx.projectType}`]),
      evidenceOf('language/cobol', 'projectKind', 'mainframe', 0.8, ['cobol-source']),
      evidenceOf('language/cobol', 'platform', 'mainframe', 0.85, ['cobol-source']),
    ];
  },
};

function mfLang(
  id: string,
  language: string,
  types: readonly string[],
  exts: readonly string[],
): ArchitectureKnowledgePack {
  return {
    id,
    languages: [language],
    projectKinds: ['mainframe'],
    extensions: exts,
    match(ctx: ProjectContext) {
      if (!typeIs(ctx, ...types) && !hasExt(ctx, ...exts)) return [];
      return [
        evidenceOf(id, 'language', language, 0.88, [`type:${ctx.projectType}`]),
        evidenceOf(id, 'projectKind', 'mainframe', 0.78, [`lang:${language}`]),
        evidenceOf(id, 'platform', 'mainframe', 0.8, [`lang:${language}`]),
      ];
    },
  };
}

export const mainframeLanguagePacks: ArchitectureKnowledgePack[] = [
  mainframePack,
  mfLang('language/rpg', 'rpg', ['rpg'], ['.rpg', '.rpgle']),
  mfLang('language/fortran', 'fortran', ['fortran'], ['.f', '.f90', '.for']),
  mfLang('language/pascal', 'pascal', ['pascal'], ['.pas', '.pp']),
  mfLang('language/ada', 'ada', ['ada'], ['.ada', '.adb', '.ads']),
  // .vb is the .NET Visual Basic extension — only claim mainframe on the
  // `visual-basic` project type (VB6 / mainframe estates), never on every .vb file.
  mfLang('language/vb', 'visual-basic', ['visual-basic'], ['.bas']),
];
