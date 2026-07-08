// Owned by the public CLI. Guards two linked rules:
//
//  1. `scan` only builds the local code map when local artifacts are wanted.
//     The map (.vibgrate/graph.json + report/html + freshness snapshot) is a
//     local artifact, and building it runs the memory-heavy in-process
//     TypeScript program — under `--no-local-artifacts` (the migration
//     `scan --push --no-local-artifacts` path) that optional build was
//     OOM-killing the whole scan and losing the baseline push.
//
//  2. `--no-local-artifacts` is actually honoured. Commander maps that negation
//     flag to `localArtifacts: false`, NOT `noLocalArtifacts: true`; the code
//     had read the never-present `noLocalArtifacts`, silently ignoring the flag
//     so every .vibgrate artifact (incl. the code map) was written regardless.
//
// Lives here (not under src/core-open, which the vendor sync wipes) so it
// survives re-vendoring.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { shouldBuildCodeMap, scanCommand } from './scan.js';

describe('shouldBuildCodeMap', () => {
  it('builds the map for a plain scan (all flags default)', () => {
    expect(shouldBuildCodeMap({})).toBe(true);
  });

  it('skips the map under --no-local-artifacts (regression: migration baseline OOM)', () => {
    expect(shouldBuildCodeMap({ noLocalArtifacts: true })).toBe(false);
  });

  it('skips the map under --no-graph', () => {
    expect(shouldBuildCodeMap({ graph: false })).toBe(false);
  });

  it('skips the map under --max-privacy (implies no local artifacts)', () => {
    expect(shouldBuildCodeMap({ maxPrivacy: true })).toBe(false);
  });

  it('still builds the map when graph is explicitly enabled and no opt-out is set', () => {
    expect(shouldBuildCodeMap({ graph: true })).toBe(true);
  });
});

describe('scan --no-local-artifacts (end-to-end flag wiring)', () => {
  let dir: string;
  let out: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(tmpdir(), 'vg-nla-'));
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 't', version: '1.0.0', dependencies: {} }),
    );
    // A TS source file makes the code map non-trivial to build — if the map
    // build were still wired under the flag, it would run (and write graph.json).
    fs.writeFileSync(path.join(dir, 'index.ts'), 'export const a = () => 1;\n');
    vi.stubEnv('VIBGRATE_DSN', '');
    out = '';
    // Progress steps render through the spinner (stdout), the summary through
    // console.log — capture both so we see the whole run.
    logSpy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      out += a.join(' ') + '\n';
    });
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      out += String(chunk);
      return true;
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
    stdoutSpy.mockRestore();
    vi.unstubAllEnvs();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes no .vibgrate artifacts and builds no code map', async () => {
    // Drive the real command so commander's flag mapping is exercised: the bug
    // was that `--no-local-artifacts` never reached the artifact/map guards.
    await scanCommand.parseAsync(['node', 'scan', dir, '--offline', '--quiet', '--no-local-artifacts']);

    // Nothing on disk — the flag's whole contract, and proof the map (a
    // .vibgrate artifact) was never built.
    expect(fs.existsSync(path.join(dir, '.vibgrate'))).toBe(false);
    // Drift still runs (the baseline the migration needs); the map step does not.
    expect(out).toContain('DriftScore');
    expect(out).not.toContain('Building code map');
  });

  it('honours the flag as commander exposes it (localArtifacts === false)', () => {
    // Documents the exact mapping the original bug missed: the negation flag is
    // `localArtifacts`, never `noLocalArtifacts`.
    const opt = scanCommand.options.find((o) => o.long === '--no-local-artifacts');
    expect(opt?.attributeName()).toBe('localArtifacts');
  });
});
