// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import type { ProjectType } from '../../types.js';
import { artifactPacks } from './packs/artifacts.js';
import { buildPacks } from './packs/build.js';
import { frameworkPacks } from './packs/frameworks.js';
import { genericSourcePack } from './packs/generic.js';
import { languagePacks } from './packs/languages.js';
import { mainframeLanguagePacks } from './packs/mainframe.js';
import { platformPacks } from './packs/platforms.js';
import { projectKindPacks } from './packs/project-kinds.js';
import type { ArchitectureKnowledgePack } from './types.js';

/**
 * ProjectTypes the CLI already detects that have no first-wave pack.
 * Level 0 is an honest outcome — a missing pack is a defect, a listed
 * type is not. Keep this next to the registry, not in a doc comment.
 */
export const UNCLASSIFIED_BY_DESIGN: ReadonlySet<ProjectType> = new Set([
  'haskell',
  'julia',
  'clojure',
  'r',
  'lua',
  'perl',
  'shell',
  'c',
  'cpp',
  'objective-c',
  'assembly',
]);

/** Types that have at least one language / mainframe / first-wave pack. */
export const PACKED_PROJECT_TYPES: ReadonlySet<ProjectType> = new Set([
  'node',
  'typescript',
  'dotnet',
  'python',
  'java',
  'go',
  'rust',
  'php',
  'ruby',
  'swift',
  'kotlin',
  'dart',
  'scala',
  'elixir',
  'groovy',
  'cobol',
  'fortran',
  'visual-basic',
  'pascal',
  'ada',
  'rpg',
]);

export const ARCHITECTURE_PACKS: readonly ArchitectureKnowledgePack[] = Object.freeze([
  genericSourcePack,
  ...languagePacks,
  ...frameworkPacks,
  ...projectKindPacks,
  ...buildPacks,
  ...platformPacks,
  ...artifactPacks,
  ...mainframeLanguagePacks,
]);

export function isProjectTypeCovered(type: ProjectType): boolean {
  return PACKED_PROJECT_TYPES.has(type) || UNCLASSIFIED_BY_DESIGN.has(type);
}
