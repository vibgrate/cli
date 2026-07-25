import { describe, it, expect } from 'vitest';
import {
  createDiscoveryGateState,
  gateDiscoveryTool,
  recordDiscoveryGateOutcome,
} from './advanced-mode.js';

describe('discovery gate', () => {
  it('allows all tools in advanced mode', () => {
    const state = createDiscoveryGateState();
    for (let i = 0; i < 20; i++) {
      const d = gateDiscoveryTool('search_code', state, { advancedMode: true });
      expect(d.allow).toBe(true);
      recordDiscoveryGateOutcome('search_code', state, { mutated: false });
    }
  });

  it('soft-nudges then hard-blocks discovery under capsule-first mode', () => {
    const state = createDiscoveryGateState();
    const opts = { advancedMode: false, softLimit: 2, hardLimit: 4 };

    expect(gateDiscoveryTool('search_code', state, opts).allow).toBe(true);
    recordDiscoveryGateOutcome('search_code', state, { mutated: false });
    recordDiscoveryGateOutcome('read_file', state, { mutated: false });

    const soft = gateDiscoveryTool('list_files', state, opts);
    expect(soft.allow).toBe(true);
    if (soft.allow) expect(soft.note).toMatch(/capsule-first/i);
    recordDiscoveryGateOutcome('list_files', state, { mutated: false });
    recordDiscoveryGateOutcome('graph_impact', state, { mutated: false });

    const hard = gateDiscoveryTool('search_code', state, opts);
    expect(hard.allow).toBe(false);
    if (!hard.allow) expect(hard.reason).toMatch(/limited/i);
  });

  it('unlocks discovery after mutation or inspect_change', () => {
    const state = createDiscoveryGateState();
    const opts = { advancedMode: false, softLimit: 1, hardLimit: 2 };
    recordDiscoveryGateOutcome('search_code', state, { mutated: false });
    recordDiscoveryGateOutcome('search_code', state, { mutated: false });
    expect(gateDiscoveryTool('search_code', state, opts).allow).toBe(false);

    recordDiscoveryGateOutcome('edit_file', state, { mutated: true });
    expect(gateDiscoveryTool('search_code', state, opts).allow).toBe(true);

    const s2 = createDiscoveryGateState();
    recordDiscoveryGateOutcome('search_code', s2, { mutated: false });
    recordDiscoveryGateOutcome('search_code', s2, { mutated: false });
    recordDiscoveryGateOutcome('inspect_change', s2, { mutated: false });
    expect(gateDiscoveryTool('read_file', s2, opts).allow).toBe(true);
  });
});
