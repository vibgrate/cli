// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import * as path from 'node:path';
import { readJsonFile, readTextFile } from '../utils/fs.js';
import type { DependencyRow, ProjectScan, ProjectType } from '../types.js';
import type { DirEntry, FileCache } from '../utils/fs.js';

const TOP_25_LANGUAGES: readonly ProjectType[] = [
  'node',
  'python',
  'java',
  'dotnet',
  'go',
  'rust',
  'php',
  'typescript',
  'ruby',
  'swift',
  'kotlin',
  'dart',
  'scala',
  'r',
  'objective-c',
  'elixir',
  'haskell',
  'lua',
  'perl',
  'julia',
  'shell',
  'clojure',
  'groovy',
  'c',
  'cpp',
] as const;

const LEGACY_LANGUAGES: readonly ProjectType[] = [
  'cobol',
  'fortran',
  'visual-basic',
  'pascal',
  'ada',
  'assembly',
  'rpg',
] as const;

const MANIFEST_TO_LANGUAGE: Array<{ name: string; type: ProjectType }> = [
  { name: 'go.mod', type: 'go' },
  { name: 'Cargo.toml', type: 'rust' },
  { name: 'composer.json', type: 'php' },
  { name: 'Package.swift', type: 'swift' },
  { name: 'pubspec.yaml', type: 'dart' },
  { name: 'build.gradle.kts', type: 'kotlin' },
  { name: 'build.sbt', type: 'scala' },
  { name: 'DESCRIPTION', type: 'r' },
  { name: 'Podfile', type: 'objective-c' },
  { name: 'mix.exs', type: 'elixir' },
  { name: 'cpanfile', type: 'perl' },
  { name: 'Project.toml', type: 'julia' },
  { name: 'deps.edn', type: 'clojure' },
  { name: 'build.gradle', type: 'groovy' },
  { name: 'tsconfig.json', type: 'typescript' },
  { name: 'Makefile', type: 'c' },
  { name: 'CMakeLists.txt', type: 'cpp' },
  { name: '*.vbp', type: 'visual-basic' },
];

const EXTENSION_TO_LANGUAGE: Array<{ extensions: string[]; type: ProjectType }> = [
  { extensions: ['.m', '.mm'], type: 'objective-c' },
  { extensions: ['.c', '.h'], type: 'c' },
  { extensions: ['.cpp', '.cc', '.cxx', '.hpp', '.hh', '.hxx'], type: 'cpp' },
  { extensions: ['.cob', '.cbl', '.cpy'], type: 'cobol' },
  { extensions: ['.f', '.for', '.f90', '.f95', '.f03', '.f08'], type: 'fortran' },
  { extensions: ['.pas', '.pp', '.lpr'], type: 'pascal' },
  { extensions: ['.adb', '.ads', '.ada'], type: 'ada' },
  { extensions: ['.asm', '.s', '.s43', '.s65'], type: 'assembly' },
  { extensions: ['.rpg', '.rpgle', '.sqlrpgle'], type: 'rpg' },
];

function makeDep(pkg: string, spec = 'unknown'): DependencyRow {
  return {
    package: pkg,
    section: 'dependencies',
    currentSpec: spec,
    resolvedVersion: null,
    latestStable: null,
    majorsBehind: null,
    drift: 'unknown',
  };
}

function parseLineDependencies(content: string, regex: RegExp, capture = 1): string[] {
  const deps = new Set<string>();
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(regex);
    if (match?.[capture]) deps.add(match[capture]);
  }
  return [...deps];
}

function getProjectName(projectPath: string, rootDir: string): string {
  return path.basename(projectPath) || path.basename(rootDir);
}

/**
 * A Makefile alone is weak evidence of a C project — monorepo roots, IaC
 * repos, and Go/Node projects commonly carry task-runner Makefiles. Only
 * claim the directory for C when the Makefile shows C build signals:
 * compiler variable assignments, gcc/clang invocations, or .c/.o targets.
 */
function makefileHasCSignals(content: string): boolean {
  return (
    /^\s*(CC|CFLAGS|LDFLAGS)\s*[:?+]?=/m.test(content) ||
    /\b(gcc|clang)\b/.test(content) ||
    /\.(c|o)\b/.test(content)
  );
}

function addProject(
  projects: ProjectScan[],
  seen: Set<string>,
  type: ProjectType,
  projectPath: string,
  rootDir: string,
  dependencies: DependencyRow[] = [],
): void {
  const normalizedPath = projectPath || '.';
  const key = `${type}:${normalizedPath}`;
  if (seen.has(key)) return;
  seen.add(key);

  projects.push({
    type,
    path: normalizedPath,
    name: getProjectName(normalizedPath, rootDir),
    frameworks: [],
    dependencies,
    dependencyAgeBuckets: {
      current: 0,
      oneBehind: 0,
      twoPlusBehind: 0,
      unknown: dependencies.length,
    },
  });
}

async function parseDepsByManifest(manifestPath: string, cache?: FileCache): Promise<DependencyRow[]> {
  const filename = path.basename(manifestPath);
  const readText = async () => (cache ? cache.readTextFile(manifestPath) : readTextFile(manifestPath));

  if (filename === 'composer.json') {
    const content = cache
      ? await cache.readJsonFile<Record<string, unknown>>(manifestPath)
      : await readJsonFile<Record<string, unknown>>(manifestPath);
    if (!content || typeof content !== 'object') return [];
    const deps = new Set<string>();
    for (const key of ['require', 'require-dev']) {
      const section = content[key];
      if (section && typeof section === 'object') {
        for (const dep of Object.keys(section as Record<string, unknown>)) deps.add(dep);
      }
    }
    return [...deps].map((dep) => makeDep(dep));
  }

  const text = await readText();
  if (!text) return [];

  if (filename === 'go.mod') return parseLineDependencies(text, /^\s*require\s+([^\s]+)\s+(.+)$/).map((dep) => makeDep(dep));
  if (filename === 'Cargo.toml') return parseLineDependencies(text, /^\s*([A-Za-z0-9_\-]+)\s*=\s*['"{]/).map((dep) => makeDep(dep));
  if (filename === 'pubspec.yaml') return parseLineDependencies(text, /^\s{2,}([A-Za-z0-9_\-]+):\s*.+$/).map((dep) => makeDep(dep));
  if (filename === 'mix.exs') return parseLineDependencies(text, /\{\s*:([a-zA-Z0-9_]+),/).map((dep) => makeDep(dep));
  if (filename === 'cpanfile') return parseLineDependencies(text, /^\s*requires\s+['"]([^'"]+)['"]/).map((dep) => makeDep(dep));
  if (filename === 'build.sbt') return parseLineDependencies(text, /"([A-Za-z0-9_.\-]+)"\s*%{1,2}\s*"([A-Za-z0-9_.\-]+)"/, 2).map((dep) => makeDep(dep));

  return [];
}

function detectExtensionBackedProjects(entries: DirEntry[]): Map<string, Set<ProjectType>> {
  const byDir = new Map<string, Set<ProjectType>>();

  for (const entry of entries) {
    if (!entry.isFile) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (!ext) continue;

    for (const mapping of EXTENSION_TO_LANGUAGE) {
      if (!mapping.extensions.includes(ext)) continue;
      const dir = path.dirname(entry.relPath) || '.';
      if (!byDir.has(dir)) byDir.set(dir, new Set<ProjectType>());
      byDir.get(dir)?.add(mapping.type);
    }
  }

  return byDir;
}

export async function scanPolyglotProjects(rootDir: string, cache?: FileCache): Promise<ProjectScan[]> {
  const entries = cache ? await cache.walkDir(rootDir) : [];

  const candidateFiles = entries.filter((entry) => entry.isFile && MANIFEST_TO_LANGUAGE.some((m) => m.name === entry.name || (m.name.startsWith('*.') && entry.name.endsWith(m.name.slice(1)))));

  const shellDirs = new Set(
    entries
      .filter((entry) => entry.isFile && entry.name.endsWith('.sh'))
      .map((entry) => path.dirname(entry.relPath) || '.'),
  );

  const projects: ProjectScan[] = [];
  const seen = new Set<string>();

  for (const file of candidateFiles) {
    const mapping = MANIFEST_TO_LANGUAGE.find((m) => m.name === file.name || (m.name.startsWith('*.') && file.name.endsWith(m.name.slice(1))));
    if (!mapping) continue;

    if (file.name === 'Makefile') {
      const text = cache ? await cache.readTextFile(file.absPath) : await readTextFile(file.absPath);
      if (!makefileHasCSignals(text)) continue;
    }

    const projectPath = path.dirname(file.relPath) || '.';
    const dependencies = await parseDepsByManifest(file.absPath, cache);
    addProject(projects, seen, mapping.type, projectPath, rootDir, dependencies);
  }

  for (const dir of shellDirs) {
    addProject(projects, seen, 'shell', dir, rootDir);
  }

  const extensionProjects = detectExtensionBackedProjects(entries);
  for (const [dir, types] of extensionProjects) {
    for (const type of types) {
      addProject(projects, seen, type, dir, rootDir);
    }
  }

  return projects;
}

export function getTop25SupportedLanguages(): readonly ProjectType[] {
  return TOP_25_LANGUAGES;
}

export function getLegacySupportedLanguages(): readonly ProjectType[] {
  return LEGACY_LANGUAGES;
}
