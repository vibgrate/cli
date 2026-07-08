import { describe, it, expect } from 'vitest';
import { formatSarif } from '../formatters/sarif.js';
import { formatMarkdown } from '../formatters/markdown.js';
import { formatText } from '../formatters/text.js';
import type { ScanArtifact } from '../types.js';

function makeArtifact(overrides: Partial<ScanArtifact> = {}): ScanArtifact {
  return {
    schemaVersion: '1.0',
    timestamp: '2026-02-16T00:00:00.000Z',
    vibgrateVersion: '0.1.0',
    rootPath: '/test',
    projects: [
      {
        type: 'node',
        path: '/test/app',
        name: 'my-app',
        runtime: '>=20.0.0',
        runtimeLatest: '22.0.0',
        runtimeMajorsBehind: 2,
        frameworks: [
          { name: 'React', currentVersion: '18.0.0', latestVersion: '19.0.0', majorsBehind: 1 },
        ],
        dependencies: [
          {
            package: 'chalk',
            section: 'dependencies',
            currentSpec: '^4.0.0',
            resolvedVersion: '4.1.2',
            latestStable: '5.4.0',
            majorsBehind: 1,
            drift: 'major-behind',
          },
        ],
        dependencyAgeBuckets: { current: 5, oneBehind: 3, twoPlusBehind: 2, unknown: 0 },
      },
    ],
    drift: {
      // Drift convention: higher = more drift (worse). 65 → high band (61-100).
      score: 65,
      riskLevel: 'high',
      components: {
        runtimeScore: 50,
        frameworkScore: 80,
        dependencyScore: 70,
        eolScore: 30,
      },
    },
    findings: [
      {
        ruleId: 'vibgrate/runtime-lag',
        level: 'warning',
        message: 'Node.js runtime ">=20.0.0" is 2 major versions behind.',
        location: '/test/app',
      },
      {
        ruleId: 'vibgrate/dependency-rot',
        level: 'error',
        message: '20% of dependencies are 2+ major versions behind.',
        location: '/test/app',
      },
    ],
    ...overrides,
  };
}

// ── SARIF formatter ──

describe('formatSarif', () => {
  it('returns valid SARIF 2.1.0 structure', () => {
    const artifact = makeArtifact();
    const sarif = formatSarif(artifact) as Record<string, unknown>;

    expect(sarif.version).toBe('2.1.0');
    expect(sarif.$schema).toContain('sarif-schema-2.1.0');
    expect(sarif.runs).toBeDefined();
    expect(Array.isArray(sarif.runs)).toBe(true);
  });

  it('includes tool driver info', () => {
    const artifact = makeArtifact();
    const sarif = formatSarif(artifact) as any;

    const driver = sarif.runs[0].tool.driver;
    expect(driver.name).toBe('vibgrate');
    expect(driver.version).toBe('0.1.0');
    expect(driver.informationUri).toBe('https://vibgrate.com');
  });

  it('maps findings to SARIF results', () => {
    const artifact = makeArtifact();
    const sarif = formatSarif(artifact) as any;

    const results = sarif.runs[0].results;
    expect(results).toHaveLength(2);
    expect(results[0].ruleId).toBe('vibgrate/runtime-lag');
    expect(results[0].level).toBe('warning');
    expect(results[0].message.text).toContain('2 major versions behind');
    expect(results[1].ruleId).toBe('vibgrate/dependency-rot');
    expect(results[1].level).toBe('error');
  });

  it('includes physical locations', () => {
    const artifact = makeArtifact();
    const sarif = formatSarif(artifact) as any;

    const loc = sarif.runs[0].results[0].locations[0].physicalLocation;
    expect(loc.artifactLocation.uri).toBe('/test/app');
  });

  it('deduplicates rules', () => {
    const artifact = makeArtifact({
      findings: [
        { ruleId: 'vibgrate/runtime-lag', level: 'warning', message: 'msg1', location: '/a' },
        { ruleId: 'vibgrate/runtime-lag', level: 'warning', message: 'msg2', location: '/b' },
      ],
    });
    const sarif = formatSarif(artifact) as any;

    const rules = sarif.runs[0].tool.driver.rules;
    expect(rules).toHaveLength(1);
    expect(rules[0].id).toBe('vibgrate/runtime-lag');
  });

  it('handles empty findings', () => {
    const artifact = makeArtifact({ findings: [] });
    const sarif = formatSarif(artifact) as any;

    expect(sarif.runs[0].results).toHaveLength(0);
    expect(sarif.runs[0].tool.driver.rules).toHaveLength(0);
  });

  it('includes invocation timestamp', () => {
    const artifact = makeArtifact();
    const sarif = formatSarif(artifact) as any;

    expect(sarif.runs[0].invocations[0].startTimeUtc).toBe('2026-02-16T00:00:00.000Z');
    expect(sarif.runs[0].invocations[0].executionSuccessful).toBe(true);
  });
});

// ── Markdown formatter ──

describe('formatMarkdown', () => {
  it('includes heading', () => {
    const md = formatMarkdown(makeArtifact());
    expect(md).toContain('# Vibgrate Drift Report');
  });

  it('includes summary table', () => {
    const md = formatMarkdown(makeArtifact());
    expect(md).toContain('**DriftScore**');
    expect(md).toContain('65/100');
    expect(md).toContain('HIGH');
  });

  it('includes score breakdown table', () => {
    const md = formatMarkdown(makeArtifact());
    expect(md).toContain('## Score Breakdown');
    expect(md).toContain('| Runtime | 50 |');
    expect(md).toContain('| Frameworks | 80 |');
  });

  it('includes per-project details', () => {
    const md = formatMarkdown(makeArtifact());
    expect(md).toContain('### my-app (node)');
    expect(md).toContain('**Runtime:** >=20.0.0');
    expect(md).toContain('2 major(s) behind');
  });

  it('includes framework details', () => {
    const md = formatMarkdown(makeArtifact());
    expect(md).toContain('React');
    expect(md).toContain('18.0.0');
    expect(md).toContain('19.0.0');
  });

  it('includes dependency bucket summary', () => {
    const md = formatMarkdown(makeArtifact());
    expect(md).toContain('5 current');
    expect(md).toContain('3 1-behind');
    expect(md).toContain('2 2+ behind');
  });

  it('includes findings table', () => {
    const md = formatMarkdown(makeArtifact());
    expect(md).toContain('## Findings');
    expect(md).toContain('vibgrate/runtime-lag');
    expect(md).toContain('vibgrate/dependency-rot');
    expect(md).toContain('🟡');
    expect(md).toContain('🔴');
  });

  it('includes drift delta when present', () => {
    const md = formatMarkdown(makeArtifact({ delta: 5 }));
    expect(md).toContain('Drift Delta');
    expect(md).toContain('+5');
    expect(md).toContain('📈');
  });

  it('shows negative drift delta', () => {
    const md = formatMarkdown(makeArtifact({ delta: -3 }));
    expect(md).toContain('-3');
    expect(md).toContain('📉');
  });

  it('handles empty findings', () => {
    const md = formatMarkdown(makeArtifact({ findings: [] }));
    expect(md).not.toContain('## Findings');
  });

  it('handles no-projects artifact', () => {
    const md = formatMarkdown(makeArtifact({ projects: [] }));
    expect(md).toContain('# Vibgrate Drift Report');
    expect(md).not.toContain('###');
  });
});

// ── Text formatter ──

describe('formatText', () => {

  it('does NOT include mermaid diagram in CLI output (mermaid is for JSON/dashboard only)', () => {
    const txt = formatText(makeArtifact({
      extended: {
        architecture: {
          archetype: 'cli',
          archetypeConfidence: 0.9,
          totalClassified: 2,
          unclassified: 0,
          layers: [],
        },
      },
      relationshipDiagram: { mermaid: 'flowchart LR\nA-->B' },
    }));

    expect(txt).not.toContain('Project Relationship Diagram');
    expect(txt).not.toContain('flowchart LR');
  });
  it('includes report header', () => {
    const text = formatText(makeArtifact());
    expect(text).toContain('Vibgrate Drift Report');
  });

  it('includes drift score', () => {
    const text = formatText(makeArtifact());
    expect(text).toContain('65/100');
  });

  it('includes project count', () => {
    const text = formatText(makeArtifact());
    expect(text).toContain('1');
  });

  it('includes score breakdown section', () => {
    const text = formatText(makeArtifact());
    expect(text).toContain('Score Breakdown');
    expect(text).toContain('Runtime');
    expect(text).toContain('Frameworks');
    expect(text).toContain('Dependencies');
    expect(text).toContain('EOL Risk');
  });

  it('includes per-project info', () => {
    const text = formatText(makeArtifact());
    expect(text).toContain('my-app');
    expect(text).toContain('node');
  });

  it('includes findings', () => {
    const text = formatText(makeArtifact());
    expect(text).toContain('Findings');
    expect(text).toContain('2 major versions behind');
  });

  it('includes timestamp', () => {
    const text = formatText(makeArtifact());
    expect(text).toContain('2026-02-16T00:00:00.000Z');
  });

  it('includes delta when present', () => {
    const text = formatText(makeArtifact({ delta: 10 }));
    expect(text).toContain('Drift Delta');
    expect(text).toContain('vs baseline');
  });

  it('handles empty projects', () => {
    const text = formatText(makeArtifact({ projects: [], findings: [] }));
    expect(text).toContain('Vibgrate Drift Report');
  });
});
