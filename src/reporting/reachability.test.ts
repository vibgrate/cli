import { describe, expect, it } from 'vitest';
import {
  analyzeReachability,
  collectPreflightDependencies,
  isMatchableIdentifier,
  specifierMatchesPackage,
  symbolIdentifier,
  REACHABILITY_ANALYZER_VERSION,
} from './reachability.js';
import type { VgGraph } from '../schema.js';
import type { RiskySymbolManifestEntry } from '../core-open/index.js';

/** Minimal graph: src/render.ts imports lodash; src/other.ts imports express. */
function testGraph(): VgGraph {
  const nodes = [
    { id: 'f1', kind: 'file', name: 'render.ts', qualifiedName: 'src/render.ts', file: 'src/render.ts' },
    { id: 'f2', kind: 'file', name: 'other.ts', qualifiedName: 'src/other.ts', file: 'src/other.ts' },
    { id: 'e1', kind: 'external', name: 'lodash', qualifiedName: 'lodash', file: '' },
    { id: 'e2', kind: 'external', name: 'express', qualifiedName: 'express', file: '' },
  ];
  const edges = [
    { id: 'i1', kind: 'import', src: 'f1', dst: 'e1' },
    { id: 'i2', kind: 'import', src: 'f2', dst: 'e2' },
  ];
  return { nodes, edges } as unknown as VgGraph;
}

const manifestEntry = (over: Partial<RiskySymbolManifestEntry> = {}): RiskySymbolManifestEntry => ({
  advisoryId: 'GHSA-aaaa-bbbb-cccc',
  aliases: ['CVE-2026-0001'],
  ecosystem: 'npm',
  package: 'lodash',
  version: '4.17.20',
  symbols: [{ symbol: 'lodash.template', kind: 'function', confidence: 0.9, source: 'osv' }],
  symbolCoverage: 'function',
  state: 'ready',
  ...over,
});

const deps = [
  { ecosystem: 'npm', package: 'lodash', version: '4.17.20' },
  { ecosystem: 'npm', package: 'left-pad', version: '1.3.0' },
  { ecosystem: 'Maven', package: 'com.acme:thing', version: '1.0.0' },
];

const fileContents: Record<string, string> = {
  'src/render.ts': "import _ from 'lodash';\nexport const page = _.template('<b><%= x %></b>');\n",
  'src/other.ts': "import express from 'express';\nexport const app = express();\n",
};

const readFile = async (absPath: string): Promise<string | null> => {
  const rel = Object.keys(fileContents).find((k) => absPath.endsWith(k));
  return rel ? fileContents[rel] : null;
};

describe('specifierMatchesPackage', () => {
  it('matches npm specifiers including subpaths and scoped packages', () => {
    expect(specifierMatchesPackage('npm', 'lodash', 'lodash')).toBe(true);
    expect(specifierMatchesPackage('npm', 'lodash', 'lodash/template')).toBe(true);
    expect(specifierMatchesPackage('npm', 'lodash', 'lodash-es')).toBe(false);
    expect(specifierMatchesPackage('npm', '@scope/pkg', '@scope/pkg/sub')).toBe(true);
  });

  it('matches PyPI by normalized top-level module and crates by underscored name', () => {
    expect(specifierMatchesPackage('PyPI', 'Requests', 'requests.sessions')).toBe(true);
    expect(specifierMatchesPackage('PyPI', 'python-dateutil', 'dateutil')).toBe(false);
    expect(specifierMatchesPackage('crates.io', 'serde-json', 'serde_json::Value')).toBe(true);
  });

  it('never matches unsupported ecosystems', () => {
    expect(specifierMatchesPackage('Maven', 'com.acme:thing', 'com.acme.thing')).toBe(false);
  });
});

describe('symbol identifier heuristics', () => {
  it('extracts the trailing identifier from qualified symbols', () => {
    expect(symbolIdentifier('lodash.template')).toBe('template');
    expect(symbolIdentifier('smallvec::SmallVec::insert_many')).toBe('insert_many');
    expect(symbolIdentifier('golang.org/x/text/language.Parse')).toBe('Parse');
  });

  it('rejects identifiers too generic to be evidence', () => {
    expect(isMatchableIdentifier('template')).toBe(true);
    expect(isMatchableIdentifier('get')).toBe(false);
    expect(isMatchableIdentifier('ab')).toBe(false);
  });
});

describe('analyzeReachability', () => {
  it('marks a referenced vulnerable symbol as reachable with call-path evidence', async () => {
    const result = await analyzeReachability({
      graph: testGraph(),
      rootDir: '/repo',
      manifest: [manifestEntry()],
      dependencies: deps,
      readFile,
    });
    expect(result.source).toBe('graph');
    expect(result.analyzerVersion).toBe(REACHABILITY_ANALYZER_VERSION);
    const reachable = result.findings.find((f) => f.tier === 'reachable');
    expect(reachable).toBeDefined();
    expect(reachable?.symbol).toBe('lodash.template');
    expect(reachable?.callPath).toEqual(['src/render.ts']);
    expect(reachable?.graphConfidence).toBeGreaterThan(0);
  });

  it('marks an un-imported package as not_reached', async () => {
    const result = await analyzeReachability({
      graph: testGraph(),
      rootDir: '/repo',
      manifest: [manifestEntry({ advisoryId: 'GHSA-dddd', package: 'left-pad', symbols: [] , symbolCoverage: 'none'})],
      dependencies: deps,
      readFile,
    });
    expect(result.findings[0].tier).toBe('not_reached');
    expect(result.findings[0].evidence).toContain('no import');
  });

  it('marks an imported package with unresolved symbols as potentially_reachable', async () => {
    const result = await analyzeReachability({
      graph: testGraph(),
      rootDir: '/repo',
      manifest: [manifestEntry({ symbols: [], symbolCoverage: 'none', state: 'pending' })],
      dependencies: deps,
      readFile,
    });
    expect(result.findings[0].tier).toBe('potentially_reachable');
  });

  it('marks an imported package as not_reached when no vulnerable symbol is referenced', async () => {
    const result = await analyzeReachability({
      graph: testGraph(),
      rootDir: '/repo',
      manifest: [
        manifestEntry({
          symbols: [{ symbol: 'lodash.escapeRegExp', kind: 'function', confidence: 0.9, source: 'osv' }],
        }),
      ],
      dependencies: deps,
      readFile,
    });
    expect(result.findings[0].tier).toBe('not_reached');
    expect(result.findings[0].evidence).toContain('none of its 1 vulnerable symbol');
  });

  it('keeps unsupported ecosystems unknown (unknown ≠ safe)', async () => {
    const result = await analyzeReachability({
      graph: testGraph(),
      rootDir: '/repo',
      manifest: [manifestEntry({ ecosystem: 'Maven', package: 'com.acme:thing' })],
      dependencies: deps,
      readFile,
    });
    expect(result.findings[0].tier).toBe('unknown');
    expect(result.findings[0].graphConfidence).toBe(0);
  });

  it('emits module-import evidence only for evaluated (supported) packages', async () => {
    const result = await analyzeReachability({
      graph: testGraph(),
      rootDir: '/repo',
      manifest: [],
      dependencies: deps,
      readFile,
    });
    const packages = result.importedModules?.map((m) => m.package);
    expect(packages).toContain('lodash');
    expect(packages).toContain('left-pad'); // evaluated, zero imports — explicit evidence
    expect(packages).not.toContain('com.acme:thing'); // unsupported → never evaluated
    const lodash = result.importedModules?.find((m) => m.package === 'lodash');
    expect(lodash?.importingFiles).toBe(1);
    const leftPad = result.importedModules?.find((m) => m.package === 'left-pad');
    expect(leftPad?.importingFiles).toBe(0);
  });

  it('degrades to all-unknown when no graph is available', async () => {
    const result = await analyzeReachability({
      graph: null,
      rootDir: '/repo',
      manifest: [manifestEntry()],
      dependencies: deps,
      readFile,
    });
    expect(result.source).toBe('none');
    expect(result.findings[0].tier).toBe('unknown');
  });
});

describe('collectPreflightDependencies', () => {
  it('dedupes coordinates, maps project types to OSV ecosystems, and skips unresolvable versions', () => {
    const result = collectPreflightDependencies(
      [
        {
          type: 'node',
          dependencies: [
            { package: 'lodash', resolvedVersion: '4.17.20', currentSpec: '^4.17.0' },
            { package: 'lodash', resolvedVersion: '4.17.20', currentSpec: '^4.17.0' },
            { package: 'mystery', resolvedVersion: null, currentSpec: 'workspace:*' },
          ],
        },
        {
          type: 'docker',
          dependencies: [{ package: 'nginx', resolvedVersion: '1.27.0', currentSpec: '1.27.0' }],
        },
      ],
      { node: 'npm' },
    );
    expect(result).toEqual([{ ecosystem: 'npm', package: 'lodash', version: '4.17.20' }]);
  });
});
