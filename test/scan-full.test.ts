import { describe, it, expect } from 'vitest';
import { buildProgram } from '../src/cli.js';

/** Guards the `vg scan --full` umbrella flag and its companions stay wired. */
describe('vg scan flags', () => {
  const scan = buildProgram().commands.find((c) => c.name() === 'scan')!;
  const flags = scan.options.map((o) => o.long);

  it('exposes --full and --vulns', () => {
    expect(flags).toContain('--full');
    expect(flags).toContain('--vulns');
  });

  it('describes --full as a comprehensive umbrella', () => {
    const full = scan.options.find((o) => o.long === '--full');
    expect(full?.description.toLowerCase()).toContain('vuln');
  });
});
