import * as path from 'node:path';
import * as semver from 'semver';
import type { ProjectScan, BreakingChangeExposureResult } from '../../core-open/index.js';
import type { FileCache, DirEntry } from '../../core-open/index.js';

/** Packages that are widely deprecated, abandoned, or known to cause upgrade pain */
const DEPRECATED_PACKAGES = new Set([
  'request', 'request-promise', 'request-promise-native', 'moment', 'node-sass', 'tslint', 'aws-sdk',
  'babel-core', 'babel-preset-env', 'babel-preset-react', 'babel-loader', 'core-js', 'istanbul',
  'istanbul-instrumenter-loader', 'left-pad', 'popper.js', 'create-react-class',
  'react-addons-css-transition-group', 'react-addons-test-utils', '@types/express-serve-static-core',
  'enzyme', 'enzyme-adapter-react-16', 'enzyme-adapter-react-17', 'react-hot-loader', 'react-loadable',
  'react-router-dom-v5-compat', 'redux-thunk', 'redux-saga', 'recompose', 'classnames', 'glamor',
  'radium', 'material-ui', '@material-ui/core', 'bower', 'grunt', 'gulp', 'browserify', 'coffee-script',
  'coffeescript', 'jade', 'nomnom', 'optimist', 'minimist', 'colors', 'faker', 'event-stream', 'ua-parser-js',
  'caniuse-db', 'circular-json', 'mkdirp', 'rimraf', 'glob', 'swig', 'dustjs-linkedin', 'hogan.js',
  'passport-local-mongoose', '@angular/http', 'rxjs-compat', 'protractor', 'karma', 'karma-jasmine', 'jasmine',
]);

/** Polyfills for APIs now built into Node 18+ or modern browsers */
const LEGACY_POLYFILLS = new Set([
  'node-fetch', 'cross-fetch', 'isomorphic-fetch', 'whatwg-fetch', 'abort-controller', 'form-data',
  'formdata-polyfill', 'web-streams-polyfill', 'whatwg-url', 'url-parse', 'domexception',
  'abortcontroller-polyfill', 'querystring', 'string_decoder', 'buffer', 'events', 'path-browserify',
  'stream-browserify', 'stream-http', 'https-browserify', 'os-browserify', 'crypto-browserify', 'assert',
  'util', 'process', 'timers-browserify', 'tty-browserify', 'vm-browserify', 'domain-browser', 'punycode',
  'readable-stream', 'es6-promise', 'promise-polyfill', 'es6-symbol', 'es6-map', 'es6-set', 'es6-weak-map',
  'es6-iterator', 'object-assign', 'object.assign', 'array.prototype.find', 'array.prototype.findindex',
  'array.prototype.flat', 'array.prototype.flatmap', 'array-includes', 'string.prototype.startswith',
  'string.prototype.endswith', 'string.prototype.includes', 'string.prototype.padstart', 'string.prototype.padend',
  'string.prototype.matchall', 'string.prototype.replaceall', 'string.prototype.trimstart',
  'string.prototype.trimend', 'string.prototype.at', 'object.entries', 'object.values', 'object.fromentries',
  'globalthis', 'symbol-observable', 'setimmediate', 'regenerator-runtime', '@babel/polyfill',
  'whatwg-encoding', 'text-encoding', 'encoding', 'unorm', 'number.isnan', 'is-nan', 'has-symbols',
  'has', 'hasown', 'safe-buffer', 'safer-buffer',
]);

const BREAKING_SIGNAL_PHRASES = [
  'BREAKING', 'Breaking Change', 'Removed', 'Deprecated', 'Migration', 'Rename', 'Drop support',
] as const;

type AutomationLevel = 'codemod-available' | 'deterministic-recipe' | 'manual';
type UpgradeDecision = 'do-nothing' | 'upgrade-safely-now' | 'plan-major-upgrade' | 'codemod-available' | 'manual-hotspots';

interface PackagePlaybook {
  impactedFeatures: string[];
  usagePatterns: RegExp[];
  automation: AutomationLevel;
  codemod?: string;
}

const PACKAGE_PLAYBOOKS: Record<string, PackagePlaybook> = {
  vue: {
    impactedFeatures: ['Options API-heavy components', 'Deprecated hooks', 'Template filters', '$listeners / $attrs merge behavior', 'Mixin-heavy architecture'],
    usagePatterns: [/\bexport\s+default\s*\{/, /\bmixins\s*:/, /\bfilters\s*:/, /\$listeners\b/, /beforeDestroy\b/, /destroyed\b/],
    automation: 'manual',
  },
  'react-router-dom': {
    impactedFeatures: ['Switch/Route v5 patterns', 'history prop mutation flows', 'withRouter HOC usage'],
    usagePatterns: [/\bSwitch\b/, /\bwithRouter\b/, /\bhistory\./, /<Route\s+component=/],
    automation: 'deterministic-recipe',
  },
  eslint: {
    impactedFeatures: ['Flat config migration', '.eslintrc plugin resolution', 'legacy parser/plugin options'],
    usagePatterns: [/\.eslintrc/, /eslintConfig/, /module\.exports\s*=\s*\[/, /extends\s*:/],
    automation: 'deterministic-recipe',
  },
  typescript: {
    impactedFeatures: ['Stricter type checks', 'tsconfig option removals', 'moduleResolution defaults changes'],
    usagePatterns: [/tsconfig\.json/, /strictNullChecks/, /noImplicitAny/, /moduleResolution/],
    automation: 'manual',
  },
  '@angular/core': {
    impactedFeatures: ['NgModule bootstrap assumptions', 'Standalone component migration', 'Deprecated lifecycle signatures'],
    usagePatterns: [/@NgModule\b/, /ngOnInit\(/, /providers\s*:/],
    automation: 'codemod-available',
    codemod: 'ng update',
  },
};

/** A serializable view of a package's upgrade playbook (no RegExp), for the hosted planner. */
export interface UpgradePlaybook {
  package: string;
  impactedFeatures: string[];
  automation: AutomationLevel;
  codemod?: string;
}

/** Look up the upgrade playbook for a package, or null when none is known. */
export function playbookFor(pkg: string): UpgradePlaybook | null {
  const p = PACKAGE_PLAYBOOKS[pkg];
  if (!p) return null;
  return {
    package: pkg,
    impactedFeatures: p.impactedFeatures,
    automation: p.automation,
    ...(p.codemod ? { codemod: p.codemod } : {}),
  };
}

function detectDecision(majorItems: number, manualHotspots: number, codemodItems: number): UpgradeDecision {
  if (majorItems === 0) return 'do-nothing';
  if (codemodItems > 0 && manualHotspots === 0) return 'codemod-available';
  if (manualHotspots > 0) return 'manual-hotspots';
  if (majorItems <= 2) return 'upgrade-safely-now';
  return 'plan-major-upgrade';
}

function normalizeMajor(version: string | null | undefined): number | null {
  if (!version) return null;
  const parsed = semver.coerce(version);
  return parsed?.major ?? null;
}

function resolveCurrentVersion(dep: { resolvedVersion: string | null; currentSpec: string }): string | null {
  if (dep.resolvedVersion && semver.valid(semver.coerce(dep.resolvedVersion))) return semver.coerce(dep.resolvedVersion)?.version ?? null;
  const min = semver.minVersion(dep.currentSpec);
  return min?.version ?? null;
}

function listInterimMajorTargets(current: number, target: number): string[] {
  if (target <= current + 1) return [];
  const out: string[] = [];
  for (let m = current + 1; m < target; m++) out.push(`${m}.x`);
  return out;
}

async function buildProjectUsageIndex(project: ProjectScan, rootDir: string, fileCache: FileCache, candidatePackages: string[]): Promise<Map<string, { importSites: number; filesTouched: number; patternHits: number }>> {
  const index = new Map<string, { importSites: number; filesTouched: number; patternHits: number }>();
  for (const pkg of candidatePackages) index.set(pkg, { importSites: 0, filesTouched: 0, patternHits: 0 });

  const entries = await fileCache.walkDir(rootDir);
  const projectPrefix = project.path.replace(/\\/g, '/').replace(/^\.\//, '');
  const projectEntries = entries.filter((e) => e.isFile && e.relPath.replace(/\\/g, '/').startsWith(projectPrefix));

  const codeEntries = projectEntries.filter((e: DirEntry) => /\.(ts|tsx|js|jsx|vue|mjs|cjs|json)$/.test(e.name));
  for (const file of codeEntries) {
    let content = '';
    try {
      content = await fileCache.readTextFile(path.join(rootDir, file.relPath));
    } catch {
      continue;
    }

    for (const pkg of candidatePackages) {
      const current = index.get(pkg);
      if (!current) continue;
      const escaped = pkg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const importRegex = new RegExp(`(?:from\\s+['\"]${escaped}['\"]|require\\(\\s*['\"]${escaped}['\"]\\s*\\)|import\\(\\s*['\"]${escaped}['\"]\\s*\\))`, 'g');
      const importMatches = content.match(importRegex) ?? [];
      if (importMatches.length > 0) {
        current.importSites += importMatches.length;
        current.filesTouched += 1;
      }

      const playbook = PACKAGE_PLAYBOOKS[pkg];
      if (playbook) {
        for (const pattern of playbook.usagePatterns) {
          const matches = content.match(new RegExp(pattern.source, 'g'));
          if (matches) current.patternHits += matches.length;
        }
      }
    }
  }

  return index;
}

export async function scanBreakingChangeExposure(
  projects: ProjectScan[],
  rootDir: string,
  fileCache: FileCache,
): Promise<BreakingChangeExposureResult> {
  const deprecated = new Set<string>();
  const legacyPolyfills = new Set<string>();
  let peerConflictsDetected = false;

  for (const project of projects) {
    for (const dep of project.dependencies) {
      if (DEPRECATED_PACKAGES.has(dep.package)) deprecated.add(dep.package);
      if (LEGACY_POLYFILLS.has(dep.package)) legacyPolyfills.add(dep.package);
      if (dep.section === 'peerDependencies' && dep.majorsBehind !== null && dep.majorsBehind >= 2) peerConflictsDetected = true;
    }
  }

  let score = 0;
  score += Math.min(deprecated.size * 10, 40);
  score += Math.min(legacyPolyfills.size * 5, 30);
  score += peerConflictsDetected ? 20 : 0;
  score = Math.min(score, 100);

  const projectIntelligence: BreakingChangeExposureResult['projectIntelligence'] = [];
  const solutionRollup = new Map<string, BreakingChangeExposureResult['solutionIntelligence'][number]>();
  let majorPackageCount = 0;
  let manualHotspots = 0;
  let codemodCandidates = 0;

  for (const project of projects) {
    const majorDeps = project.dependencies.filter((d) => (d.majorsBehind ?? 0) >= 1 && d.latestStable);
    if (majorDeps.length === 0) {
      projectIntelligence.push({
        project: project.name,
        projectPath: project.path,
        packages: [],
        recommendation: 'do-nothing',
      });
      continue;
    }

    const usageIndex = await buildProjectUsageIndex(project, rootDir, fileCache, majorDeps.map((d) => d.package));
    const packages = majorDeps.map((dep) => {
      const currentVersion = resolveCurrentVersion(dep);
      const targetVersion = dep.latestStable;
      const currentMajor = normalizeMajor(currentVersion);
      const targetMajor = normalizeMajor(targetVersion);
      const interimMajors = currentMajor !== null && targetMajor !== null ? listInterimMajorTargets(currentMajor, targetMajor) : [];
      const usage = usageIndex.get(dep.package) ?? { importSites: 0, filesTouched: 0, patternHits: 0 };
      const fileCount = Math.max(1, project.fileCount ?? 1);
      const touchedPercent = Math.min(100, Math.round(((usage.filesTouched + usage.patternHits) / fileCount) * 100));

      const playbook = PACKAGE_PLAYBOOKS[dep.package];
      const impactedFeatures = playbook?.impactedFeatures ?? ['Public API usage patterns', 'Configuration surface', 'Runtime compatibility expectations'];
      const automatable: AutomationLevel = playbook?.automation ?? (usage.patternHits > 0 ? 'manual' : 'deterministic-recipe');

      majorPackageCount++;
      if (automatable === 'manual') manualHotspots++;
      if (automatable === 'codemod-available') codemodCandidates++;

      return {
        package: dep.package,
        currentVersion,
        targetVersion,
        majorJumpCount: dep.majorsBehind ?? 0,
        interimMajors,
        releaseNoteSources: ['GitHub Releases', 'Repository tags', 'CHANGELOG.md'],
        parsedSignals: [...BREAKING_SIGNAL_PHRASES],
        impactedFeatures,
        usage: {
          importSites: usage.importSites,
          filesTouchedEstimate: usage.filesTouched,
          functionsTouchedEstimate: usage.patternHits,
          touchedPercent,
        },
        automatable,
        codemod: playbook?.codemod,
      };
    });

    const rec = detectDecision(packages.length, packages.filter((p) => p.automatable === 'manual').length, packages.filter((p) => p.automatable === 'codemod-available').length);
    projectIntelligence.push({
      project: project.name,
      projectPath: project.path,
      packages,
      recommendation: rec,
    });

    if (project.solutionId) {
      const key = project.solutionId;
      const existing = solutionRollup.get(key) ?? {
        solutionId: key,
        solutionName: project.solutionName ?? key,
        projectCount: 0,
        majorPackages: 0,
        recommendation: 'do-nothing' as UpgradeDecision,
      };
      existing.projectCount += 1;
      existing.majorPackages += packages.length;
      existing.recommendation = detectDecision(existing.majorPackages, manualHotspots, codemodCandidates);
      solutionRollup.set(key, existing);
    }
  }

  const overallRecommendation = detectDecision(majorPackageCount, manualHotspots, codemodCandidates);

  return {
    deprecatedPackages: [...deprecated].sort(),
    legacyPolyfills: [...legacyPolyfills].sort(),
    peerConflictsDetected,
    exposureScore: score,
    projectIntelligence,
    solutionIntelligence: [...solutionRollup.values()],
    overallRecommendation,
  };
}
