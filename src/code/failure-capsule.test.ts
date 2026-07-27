import { describe, it, expect } from 'vitest';
import { buildFailureCapsule, FAILURE_CAPSULE_SCHEMA_VERSION, renderFailureCapsule } from './failure-capsule.js';
import { buildTaskCapsule } from './capsule.js';
import { fixtureGraph } from './graph-fixture.js';

describe('failure capsule', () => {
  it('builds from a verify command failure with redaction', () => {
    const capsule = buildTaskCapsule(fixtureGraph(), 'raise timeout', {
      readFile: (f) => (f === 'src/scan.ts' ? 'function scanDir() { const timeout = 0; }' : null),
    });
    const fc = buildFailureCapsule({
      verify: {
        command: 'npm test',
        exitCode: 1,
        stdout: 'AssertionError: expected 5000\napi_key=sk_live_abc123secret\n',
      },
      capsule,
      changedFiles: ['src/scan.ts'],
      modelId: 'scripted',
    });
    expect(fc.schemaVersion).toBe(FAILURE_CAPSULE_SCHEMA_VERSION);
    expect(fc.failedStep.type).toBe('verify');
    expect(fc.failedStep.command).toBe('npm test');
    expect(fc.diagnosticExcerpt).toContain('AssertionError');
    expect(fc.diagnosticExcerpt).not.toMatch(/sk_live/);
    expect(fc.affectedSymbols.some((s) => s.file === 'src/scan.ts')).toBe(true);
    expect(fc.likelyCorrections.length).toBeGreaterThan(0);
    expect(fc.rendered).toContain('Failure Capsule');
    expect(renderFailureCapsule(fc)).toContain('npm test');
  });

  it('builds from a ladder syntax failure', () => {
    const fc = buildFailureCapsule({
      ladderSteps: [
        {
          step: { kind: 'syntax', files: ['src/missing.ts'], detail: 'check' },
          ok: false,
          message: 'syntax check failed — missing: src/missing.ts',
        },
      ],
      changedFiles: ['src/missing.ts'],
    });
    expect(fc.failedStep.type).toBe('syntax');
    expect(fc.likelyCorrections.some((h) => /missing files/i.test(h))).toBe(true);
  });
});
