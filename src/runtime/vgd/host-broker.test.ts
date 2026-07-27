import { describe, it, expect, beforeEach } from 'vitest';
import { VgdHostBroker, resetVgdHostBroker } from './host-broker.js';

function fakeLib(reply = 'host-ok') {
  return {
    getLlama: async () => ({
      loadModel: async () => ({
        createContext: async () => ({ getSequence: () => ({}) }),
      }),
    }),
    LlamaChatSession: class {
      async prompt() {
        return reply;
      }
    },
  };
}

describe('VgdHostBroker', () => {
  beforeEach(() => resetVgdHostBroker());

  it('reports binding not ready until set', async () => {
    const b = new VgdHostBroker();
    expect(b.status().bindingReady).toBe(false);
    const load = await b.load('/m.gguf');
    expect(load.ok).toBe(false);
  });

  it('loads and generates with injected binding', async () => {
    const b = new VgdHostBroker();
    b.setBinding(fakeLib('generated'));
    const load = await b.load('/models/a.gguf');
    expect(load.ok).toBe(true);
    expect(b.status().bindingReady).toBe(true);
    expect(b.status().poolSize).toBeGreaterThanOrEqual(1);

    const gen = await b.generate('/models/a.gguf', [{ role: 'user', content: 'hi' }]);
    expect(gen.ok).toBe(true);
    if (gen.ok) {
      expect(gen.result.text).toBe('generated');
      expect(gen.result.latencyMs).toBeGreaterThanOrEqual(0);
    }

    const unload = await b.unload();
    expect(unload.ok).toBe(true);
    expect(b.status().poolSize).toBe(0);
  });

  it('refcounts multi-client leases so first release does not drop the session', async () => {
    const b = new VgdHostBroker();
    b.setBinding(fakeLib());
    const a = await b.load('/shared.gguf', 'cli');
    const c = await b.load('/shared.gguf', 'vscode');
    expect(a.ok && c.ok).toBe(true);
    expect(b.leaseCount('/shared.gguf')).toBe(2);
    expect(b.status().poolSize).toBe(1);

    const u1 = await b.unload('/shared.gguf', 'cli');
    expect(u1.remainingLeases).toBe(1);
    expect(b.status().poolSize).toBe(1);

    const u2 = await b.unload('/shared.gguf', 'vscode');
    expect(u2.remainingLeases).toBe(0);
    expect(u2.cleared).toBe(1);
    expect(b.status().poolSize).toBe(0);
  });

  it('status lists sessions for doctor', async () => {
    const b = new VgdHostBroker();
    b.setBinding(fakeLib());
    await b.load('/doc.gguf', 't');
    const st = b.status();
    expect(st.sessions.length).toBeGreaterThanOrEqual(1);
    expect(st.leases['/doc.gguf']).toBe(1);
  });
});
