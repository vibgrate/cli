import { afterEach, describe, expect, it } from 'vitest';
import { buildGraph } from '../src/engine/build.js';
import { warningCodeList } from '../src/core-open/warnings.js';
import { cleanup, makeProject } from './helpers.js';

const PIN = '2020-01-01T00:00:00.000Z';
const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) cleanup(dirs.pop()!);
});

/** Published codes. A rename or a duplicate fails this list. */
const PUBLISHED_CODES = [
  'VG_WARN_BASELINE_UNREADABLE',
  'VG_WARN_BUILD_FILE_OVERSIZE',
  'VG_WARN_CVSS_UNPARSEABLE',
  'VG_WARN_HCL_GRAMMAR_UNAVAILABLE',
  'VG_WARN_HCL_NO_TREE',
  'VG_WARN_HCL_PARTIAL',
  'VG_WARN_LICENSE_UNPARSEABLE',
  'VG_WARN_LICENSE_UNREPRESENTABLE',
  'VG_WARN_NON_TEXT_FILE',
  'VG_WARN_PARSE_FAILED',
  'VG_WARN_PURL_UNAVAILABLE',
  'VG_WARN_SBOM_LOSSY_EDGES',
  'VG_WARN_SBOM_LOSSY_MANIFEST',
  'VG_WARN_SBOM_UNKNOWN_ECOSYSTEM',
  'VG_WARN_SBOM_UNTRACKED_EDGES',
  'VG_WARN_SCAN_FILE_OVERSIZE',
  'VG_WARN_SCAN_PATH_SKIPPED',
  'VG_WARN_TOOLCHAIN_EXTRACTION_FAILED',
  'VG_WARN_TOOLCHAIN_NODE_CAP',
  'VG_WARN_TSC_RESOLVER_SKIPPED',
  'VG_WARN_WORKFLOW_STEP_CAP',
  'VG_WARN_YAML_DOCUMENT_SKIPPED',
  'VG_WARN_YAML_DOCUMENT_UNMATERIALISED',
  'VG_WARN_YAML_PARSE_FAILED',
] as const;

describe('warning code registry', () => {
  it('publishes each code once', () => {
    const codes = warningCodeList();
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes.every((code) => /^VG_WARN_[A-Z0-9_]+$/.test(code))).toBe(true);
    expect([...codes].sort((a, b) => a.localeCompare(b))).toEqual([...PUBLISHED_CODES]);
  });
});

describe('build oversize warnings', () => {
  it('stamps VG_WARN_BUILD_FILE_OVERSIZE in order', async () => {
    const big = 'x'.repeat(400);
    const root = makeProject({
      'small.ts': 'export const a = 1;\n',
      'aaa-generated.ts': big,
      'zzz-generated.ts': big,
    });
    dirs.push(root);
    const result = await buildGraph({
      root,
      generatedAt: PIN,
      inline: true,
      noCache: true,
      limits: { maxFileBytes: 256 },
    });
    const oversize = result.codedWarnings.filter((warning) => warning.code === 'VG_WARN_BUILD_FILE_OVERSIZE');
    expect(oversize.map((warning) => warning.code)).toEqual([
      'VG_WARN_BUILD_FILE_OVERSIZE',
      'VG_WARN_BUILD_FILE_OVERSIZE',
    ]);
    expect(oversize[0]?.message).toContain('aaa-generated.ts');
    expect(oversize[1]?.message).toContain('zzz-generated.ts');
    expect(oversize[0]!.message.localeCompare(oversize[1]!.message)).toBeLessThan(0);
    expect(result.warnings).toContain(`${oversize[0]!.message} [VG_WARN_BUILD_FILE_OVERSIZE]`);
    expect(result.warnings).toContain(`${oversize[1]!.message} [VG_WARN_BUILD_FILE_OVERSIZE]`);
  });
});
