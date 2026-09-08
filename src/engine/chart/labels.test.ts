import { describe, expect, it } from 'vitest';
import { chartPage } from './page.js';
import { kindLabel, policyLabel, purposeLabel, roleLabel } from './labels.js';

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

describe('chart page chrome', () => {
  it('is English-only and hides internals', () => {
    const html = chartPage();
    expect(html).toContain('Code map');
    expect(html).toContain('By job');
    expect(html).toContain('Architecture on');
    expect(html).toContain('Missing steps');
    expect(html).not.toContain('HAILE');
    expect(html).not.toContain('confidence');
    expect(html).not.toContain('node_id');
  });
});
