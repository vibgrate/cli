import { describe, expect, it } from 'vitest';
import { sanitizeOverview, sanitizeSlice } from './sanitize.js';

describe('architecture payload sanitiser', () => {
  it('drops a payload with the wrong magic', () => {
    expect(sanitizeOverview({ magic: 'nope', packages: [], edges: [], meta: {} })).toBeNull();
    expect(sanitizeSlice({ magic: 'nope', packageId: 'x', columns: [], edges: [] })).toBeNull();
  });

  it('keeps a well-formed overview and caps packages', () => {
    const clean = sanitizeOverview({
      magic: 'vg.arch.overview.v1',
      packages: [{ id: 'p', name: 'api', path: 'packages/api', kind: 'package', symbols: 12, findings: 1, missingSteps: 0, job: 'service', policy: null }],
      edges: [{ id: 'e', src: 'p', dst: 'q', kind: 'import', weight: 3 }],
      meta: { architectureLoaded: true, policy: 'layered-v1', policyLabel: 'Layered', symbols: 12, packages: 1, findings: 1, missingSteps: 0, title: 'Code map' },
    });
    expect(clean?.packages).toHaveLength(1);
    expect(clean?.edges[0]?.weight).toBe(3);
  });
});
