import { describe, expect, it } from 'vitest';
import { fixtureGraph } from '../../code/graph-fixture.js';
import { emptySidecar } from '../haile/sidecar.js';
import { HAILE_ENGINE_VERSION, HAILE_IR, HAILE_MAGIC, HAILE_TAXONOMY } from '../haile/types.js';
import type { HaileSidecar, HaileSymbol } from '../haile/types.js';
import { pathJson, projectChart, searchNodes, showJsonFor } from './model.js';

function scanSymbol(over: Partial<HaileSymbol> = {}): HaileSymbol {
  return {
    node_id: 'scanDir',
    file_path: 'src/scan.ts',
    name: 'scanDir',
    qualified_name: 'scanDir',
    symbol_kind: 'function',
    role: { primary: 'application_service', alternatives: [], confidence: 0.9, band: 'high' },
    purposes: [
      { purpose: 'query', confidence: 0.8 },
      { purpose: 'persist', confidence: 0.91 },
      { purpose: 'validate', confidence: 0.4 },
    ],
    intent: { text: 'scans a directory and writes a report', verbs: ['scan', 'write'], objects: ['directory', 'report'] },
    evidence: [{ kind: 'name', signal: 'scanDir', weight: 0.4 }],
    findings: [
      { rule: 'layered-v1/demo', severity: 'hard', message: 'own-body write', line: 12 },
      { rule: 'layered-v1/inherited', severity: 'warn', message: 'inherited only', line: 0 },
    ],
    ...over,
  };
}

function sidecarWith(symbols: HaileSymbol[]): HaileSidecar {
  return {
    magic: HAILE_MAGIC,
    taxonomy: HAILE_TAXONOMY,
    ir: HAILE_IR,
    corpus_hash: 'test',
    engine_version: HAILE_ENGINE_VERSION,
    profile: 'balanced',
    policy: 'layered-v1',
    symbols,
  };
}

describe('chart view-model', () => {
  it('hides files and paints graph-only when the sidecar is absent', () => {
    const payload = projectChart(fixtureGraph(), null);
    expect(payload.nodes.every((n) => n.kind !== 'file')).toBe(true);
    expect(payload.meta.architectureLoaded).toBe(false);
    expect(payload.nodes.find((n) => n.id === 'scanDir')?.job).toBe('Function');
    expect(payload.nodes.find((n) => n.id === 'scanDir')?.classified).toBe(false);
    expect(payload.nodes.find((n) => n.id === 'scanDir')?.pulse).toBe(false);
    expect(payload.nodes.find((n) => n.id === 'scanDir')?.missingStep).toBe(false);
  });

  it('joins the sidecar on node id and pulses only line > 0', () => {
    const payload = projectChart(fixtureGraph(), sidecarWith([scanSymbol()]));
    const scan = payload.nodes.find((n) => n.id === 'scanDir');
    expect(scan?.classified).toBe(true);
    expect(scan?.job).toBe('Service');
    expect(scan?.purposes.map((p) => p.label)).toEqual(['Writes data', 'Reads data']);
    expect(scan?.pulse).toBe(true);
    expect(payload.meta.pulses).toBe(1);
    expect(payload.meta.architectureLoaded).toBe(true);
    expect(payload.meta.policyLabel).toMatch(/Layered/);
  });

  it('drops purposes below the floor and caps chips at 3', () => {
    const payload = projectChart(
      fixtureGraph(),
      sidecarWith([
        scanSymbol({
          purposes: [
            { purpose: 'persist', confidence: 0.99 },
            { purpose: 'query', confidence: 0.9 },
            { purpose: 'validate', confidence: 0.8 },
            { purpose: 'render', confidence: 0.7 },
            { purpose: 'cache', confidence: 0.2 },
          ],
          findings: [],
        }),
      ]),
    );
    const scan = payload.nodes.find((n) => n.id === 'scanDir');
    expect(scan?.purposes.map((p) => p.label)).toEqual(['Writes data', 'Reads data', 'Checks input']);
    expect(scan?.pulse).toBe(false);
  });

  it('does not invent a missing step when extract gaps are absent', () => {
    const payload = projectChart(fixtureGraph(), sidecarWith([scanSymbol()]));
    expect(payload.nodes.find((n) => n.id === 'scanDir')?.missingStep).toBe(false);
  });

  it('treats extract gaps as missing steps, not pulses', () => {
    const symbol = scanSymbol({
      findings: [{ rule: 'layered-v1/inherited', severity: 'warn', message: 'inherited only', line: 0 }],
    }) as HaileSymbol & { extract_gaps: Array<{ message: string }> };
    symbol.extract_gaps = [{ message: 'call to writeReport never made the map' }];
    const payload = projectChart(fixtureGraph(), sidecarWith([symbol]));
    const scan = payload.nodes.find((n) => n.id === 'scanDir');
    expect(scan?.missingStep).toBe(true);
    expect(scan?.missingStepText).toBe('call to writeReport never made the map');
    expect(scan?.pulse).toBe(false);
    expect(payload.meta.missingSteps).toBe(1);
    expect(payload.meta.pulses).toBe(0);
  });

  it('matches vg show --json on /api/node', () => {
    const graph = fixtureGraph();
    const node = graph.nodes.find((n) => n.id === 'scanDir')!;
    const body = showJsonFor(graph, node, sidecarWith([scanSymbol()]));
    expect(body.name).toBe('scanDir');
    expect(body.calls).toEqual(['readConfig']);
    expect((body.arch as { role: { primary: string } }).role.primary).toBe('application_service');
    expect((body.view as { job: string }).job).toBe('Service');
  });

  it('accepts an empty sidecar as loaded-but-unclassified', () => {
    const payload = projectChart(fixtureGraph(), emptySidecar('test'));
    expect(payload.meta.architectureLoaded).toBe(true);
    expect(payload.meta.classified).toBe(0);
    expect(payload.nodes.find((n) => n.id === 'scanDir')?.job).toBe('Function');
  });

  it('searches English labels and names', () => {
    const payload = projectChart(fixtureGraph(), sidecarWith([scanSymbol()]));
    expect(searchNodes(payload, 'scan').map((n) => n.id)).toContain('scanDir');
    expect(searchNodes(payload, 'Writes data').map((n) => n.id)).toContain('scanDir');
    expect(searchNodes(payload, 'no-such-symbol')).toEqual([]);
  });

  it('reuses the vg path engine', () => {
    const graph = fixtureGraph();
    const found = pathJson(graph, 'formatReport', 'readConfig');
    expect(found).toMatchObject({ connected: true, ids: ['formatReport', 'scanDir', 'readConfig'] });
    const miss = pathJson(graph, 'scanDir', 'missing');
    expect(miss).toMatchObject({ connected: false });
  });
});
