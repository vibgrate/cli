import { describe, expect, it } from 'vitest';
import { chartPage } from './page.js';
import { kindLabel, policyLabel, purposeLabel, roleLabel } from './labels.js';

describe('chart labels', () => {
  it('speaks jobs, not taxonomy slugs', () => {
    expect(roleLabel('controller')).toBe('HTTP handler');
    expect(roleLabel('cross_cutting', 'authenticate')).toBe('Login check');
    expect(roleLabel('cross_cutting', 'validate')).toBe('Validation');
    expect(roleLabel('cross_cutting', 'log')).toBe('Logging');
    expect(roleLabel('cross_cutting')).toBe('Cross-cutting');
    expect(roleLabel('application_service')).toBe('Service');
    expect(purposeLabel('persist')).toBe('Writes data');
    expect(purposeLabel('authenticate')).toBe('Checks who you are');
    expect(kindLabel('route')).toBe('HTTP handler');
  });

  it('never returns a raw slug the operator would have to decode', () => {
    expect(roleLabel('controller')).not.toMatch(/_/);
    expect(purposeLabel('network_io')).toBe('Talks over HTTP');
    expect(policyLabel('layered-v1')).toMatch(/Layered/);
    expect(policyLabel('hexagonal-v1')).toMatch(/Hexagonal/);
  });
});

describe('chart page chrome', () => {
  it('is English-only and hides internals', () => {
    const html = chartPage();
    expect(html).toContain('Code map');
    expect(html).toContain('Workspace');
    expect(html).not.toContain('HAILE');
    expect(html).not.toContain('confidence');
    expect(html).not.toContain('node_id');
    expect(html).toContain('data-overlay="vulns"');
    expect(html).not.toMatch(/Architecture Health Score/i);
  });

  it('opens on packages, not a 29k-symbol camera', () => {
    const html = chartPage();
    expect(html).toContain('/api/overview');
    expect(html).toContain('/api/slice');
    expect(html).not.toContain('/api/graph');
    expect(html).not.toContain('function sizeMap(');
    expect(html).not.toContain('LANE_X');
  });
});
