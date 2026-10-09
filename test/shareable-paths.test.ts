import { describe, expect, it } from 'vitest';
import { formatMarkdown as formatMarkdownCore } from '../src/core-open/formatters/markdown.js';
import { formatSarif } from '../src/core-open/formatters/sarif.js';
import type { Finding, ScanArtifact } from '../src/core-open/types.js';
import { redactHomePaths, scanRootFromArtifactFile, shareablePath } from '../src/core-open/utils/shareable-path.js';
import { formatHtmlReport } from '../src/reporting/formatters/html.js';
import { formatMarkdown } from '../src/reporting/formatters/markdown.js';
import { findingsSuite, renderJUnitReport, securityGateSuite } from '../src/reporting/junit-report.js';

/**
 * One tree, two machines. `root` is the scan directory. `cache` and `climbed`
 * are the same files outside that directory, written the way each machine
 * would spell them.
 */
function artifactAt(root: string, cache: string, climbed: string): ScanArtifact {
  return {
    schemaVersion: '1.0',
    timestamp: '2026-01-01T00:00:00.000Z',
    vibgrateVersion: '0.0.0-test',
    rootPath: root,
    projects: [
      {
        type: 'node',
        path: root,
        name: 'app',
        frameworks: [],
        dependencies: [],
        dependencyAgeBuckets: { current: 0, oneBehind: 0, twoPlusBehind: 0, unknown: 0 },
      },
    ],
    drift: {
      score: 10,
      riskLevel: 'low',
      components: { runtimeScore: 0, frameworkScore: 0, dependencyScore: 0, eolScore: 0 },
    },
    findings: [
      finding(`${root}/package.json`, `lockfile ${root}/package.json is old`),
      finding(cache, 'cache lives outside the scan root'),
      finding(climbed, 'climbed out of the scan root'),
    ],
    extended: {
      security: {
        schema: 'vg.security.v1',
        engine: 'test',
        packs: { iac: '1' },
        facts: { received: 1, evaluated: 1, rejected: 0 },
        findings: [
          {
            id: 'a'.repeat(32),
            pack: 'iac',
            packVersion: '1',
            rule: 'public-bucket',
            severity: 'high',
            message: `open bucket in ${root}/infra/main.tf`,
            path: `${root}/infra/main.tf`,
          },
        ],
      },
    },
  };
}

function finding(location: string, message: string): Finding {
  return { ruleId: 'vibgrate/runtime-lag', level: 'warning', message, location };
}

const DEV = artifactAt(
  '/home/dev/app',
  '/home/dev/.cache/vibgrate/cas',
  '../../../home/dev/.local/state/graph.json',
);
const CASEY = artifactAt(
  '/Users/casey/app',
  '/Users/casey/.cache/vibgrate/cas',
  '../../../Users/casey/.local/state/graph.json',
);

function machineReadable(scan: ScanArtifact, root: string): string {
  const json = JSON.stringify(redactHomePaths(scan, root));
  const sarif = JSON.stringify(formatSarif(scan, root));
  const md = `${formatMarkdownCore(scan, root)}\n${formatMarkdown(scan, root)}`;
  const html = formatHtmlReport(scan, root);
  const junit = renderJUnitReport({
    name: 'vg scan',
    suites: [
      findingsSuite(scan.findings, 'warn', root),
      securityGateSuite({
        status: 'evaluated',
        findings: scan.extended!.security!.findings,
        failingIds: [scan.extended!.security!.findings[0]!.id],
      }, root),
    ],
  });
  return [json, sarif, md, html, junit].join('\n');
}

describe('shareable home paths', () => {
  it('drops home prefixes from default machine-readable output', () => {
    const text = machineReadable(DEV, '/home/dev/app') + machineReadable(CASEY, '/Users/casey/app');
    expect(text).not.toContain('/home/dev');
    expect(text).not.toContain('/Users/casey');
    expect(text).not.toContain('../../../home/');
    expect(text).not.toContain('../../../Users/');

    const shareable = redactHomePaths(DEV, '/home/dev/app');
    expect(shareable.rootPath).toBe('.');
    expect(shareable.projects[0]?.path).toBe('.');
    expect(shareable.findings.map((f) => f.location)).toEqual([
      'package.json',
      '~/.cache/vibgrate/cas',
      '~/.local/state/graph.json',
    ]);
    expect(shareable.extended?.security?.findings[0]?.path).toBe('infra/main.tf');
    expect(shareable.findings[0]?.message).toBe('lockfile package.json is old');
    expect(DEV.findings[0]?.location).toBe('/home/dev/app/package.json');
  });

  it('produces the same relative artifact from two home prefixes', () => {
    const alice = artifactAt(
      '/home/alice/work',
      '/home/alice/.cache/vibgrate/cas',
      '../../../home/alice/.local/state/graph.json',
    );
    const bob = artifactAt(
      '/Users/bob/work',
      '/Users/bob/.cache/vibgrate/cas',
      '../../../Users/bob/.local/state/graph.json',
    );
    expect(redactHomePaths(alice, '/home/alice/work')).toEqual(redactHomePaths(bob, '/Users/bob/work'));
    expect(formatSarif(alice, '/home/alice/work')).toEqual(formatSarif(bob, '/Users/bob/work'));
    const once = redactHomePaths(alice, '/home/alice/work');
    expect(redactHomePaths(once, '/home/alice/work')).toEqual(once);
  });

  it('leaves non-home paths, URLs, and opaque tokens unchanged', () => {
    expect(shareablePath('/test/app')).toBe('/test/app');
    expect(shareablePath('/fixture')).toBe('/fixture');
    expect(shareablePath('https://github.com/home/dev/app')).toBe('https://github.com/home/dev/app');
    expect(shareablePath('AAAA/home/abcd/BBBB')).toBe('AAAA/home/abcd/BBBB');
    expect(shareablePath('/home/../etc/passwd')).toBe('/etc/passwd');
    expect(shareablePath('package.json', '/home/dev/app')).toBe('package.json');
    expect(shareablePath('see https://github.com/home/dev/app and /home/dev/app/package.json', '/home/dev/app'))
      .toBe('see https://github.com/home/dev/app and package.json');

    const kept = artifactAt('/test/app', '/test/cache', 'notes');
    kept.findings = [finding('/test/app', 'kept')];
    kept.extended = undefined;
    const sarif = JSON.stringify(formatSarif(kept));
    expect(sarif).toContain('/test/app');
  });

  it('rewrites Windows home paths and paths that only share a prefix', () => {
    expect(shareablePath('C:\\Users\\casey\\app\\src\\a.ts', 'C:/Users/casey/app')).toBe('src/a.ts');
    expect(shareablePath('/home/dev/app/src/c++/main.cpp', '/home/dev/app')).toBe('src/c++/main.cpp');
    expect(shareablePath('/home/dev/app-extra/file.ts', '/home/dev/app')).toBe('~/app-extra/file.ts');
    expect(shareablePath('/home/dev', '/home/dev/app')).toBe('~');
  });

  it('infers a scan root only for artifacts stored under .vibgrate', () => {
    expect(scanRootFromArtifactFile('/home/dev/app/.vibgrate/scan_result.json')).toBe('/home/dev/app');
    expect(scanRootFromArtifactFile('/tmp/scan_result.json')).toBeUndefined();
  });

  it('rewrites build and doctor JSON fields', () => {
    const built = redactHomePaths({
      cas: { dir: '/home/dev/.cache/vibgrate/cas' },
      artifacts: { graphPath: '/home/dev/app/.vibgrate/graph.json', reportPath: '/home/dev/app/.vibgrate/report.md' },
    }, '/home/dev/app');
    expect(built.cas.dir).toBe('~/.cache/vibgrate/cas');
    expect(built.artifacts.graphPath).toBe('.vibgrate/graph.json');
    expect(built.artifacts.reportPath).toBe('.vibgrate/report.md');

    const diagnosis = redactHomePaths({
      root: '/home/dev/app',
      map: { path: '/home/dev/.local/state/vibgrate/graph.json' },
    }, '/home/dev/app');
    expect(diagnosis.root).toBe('.');
    expect(diagnosis.map.path).toBe('~/.local/state/vibgrate/graph.json');
  });
});
