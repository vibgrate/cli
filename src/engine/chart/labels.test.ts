import { describe, expect, it } from 'vitest';
import { chartPage } from './page.js';
import { kindLabel, policyLabel, purposeLabel, roleLabel } from './labels.js';
import { jobLabel } from './layout.js';

describe('chart labels', () => {
  it('speaks jobs, not taxonomy slugs', () => {
    expect(roleLabel('controller')).toBe('HTTP handler');
    expect(roleLabel('cross_cutting')).toBe('Login check');
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

describe('jobLabel', () => {
  it('uses graph kinds when architecture is off', () => {
    expect(jobLabel('controller', false, 'method')).toBe('Method');
    expect(jobLabel('', false, 'function')).toBe('Function');
    expect(jobLabel('', false, 'component')).toBe('Component');
  });

  it('names every classified role, not only handlers and services', () => {
    expect(jobLabel('controller', true, 'method')).toBe('HTTP handler');
    expect(jobLabel('adapter', true, 'function')).toBe('Adapter');
    expect(jobLabel('utility', true, 'function')).toBe('Helper');
    expect(jobLabel('infrastructure', true, 'function')).toBe('Infrastructure');
    expect(jobLabel('worker', true, 'function')).toBe('Worker');
    expect(jobLabel('messaging', true, 'function')).toBe('Messaging');
    expect(jobLabel('domain_service', true, 'function')).toBe('Domain rule');
    expect(jobLabel('port', true, 'interface')).toBe('Contract');
    expect(jobLabel('integration', true, 'function')).toBe('Integration');
    expect(jobLabel('test_support', true, 'function')).toBe('Test helper');
    expect(jobLabel('unknown', true, 'function')).toBe('Unclassified');
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
