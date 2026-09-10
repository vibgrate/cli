import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadArchitecturePolicy } from './policy-overlay.js';
import { inferArchitecturePolicy, renderArchitecturePolicy, seedArchitecturePolicy } from './policy-seed.js';
import { emptySidecar } from './sidecar.js';
import type { HaileSymbol } from './types.js';

function symbol(role: string): HaileSymbol {
  return {
    node_id: role,
    file_path: 'src/app.ts',
    name: role,
    qualified_name: role,
    symbol_kind: 'method',
    role: { primary: role, alternatives: [], confidence: 0.8, band: 'high' },
    purposes: [{ purpose: 'query', confidence: 0.5 }],
    intent: { text: 'queries', verbs: ['query'], objects: [] },
    evidence: [],
  };
}

describe('P2 architecture policy seed', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it('renders a vg.arch.policy.v1 document with the inferred pack and no codename', () => {
    const text = renderArchitecturePolicy('layered-v1');
    expect(text).toMatch(/schema = "vg\.arch\.policy\.v1"/);
    expect(text).toMatch(/policy = "layered-v1"/);
    expect(text).toMatch(/team\//);
    expect(text).toMatch(/hexagonal-v1 \| layered-v1 \| vertical-v1/);
    expect(text.toLowerCase()).not.toContain('haile');
    // The starter file must parse and load as a valid policy with no overlays.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-init-policy-'));
    dirs.push(root);
    fs.mkdirSync(path.join(root, '.vibgrate'));
    fs.writeFileSync(path.join(root, '.vibgrate', 'architecture.toml'), text);
    expect(loadArchitecturePolicy(root)).toMatchObject({ policy: 'layered-v1', overlays: [] });
  });

  it('infers layered-v1 when controller/repository roles dominate', () => {
    const doc = emptySidecar('x');
    doc.symbols = [
      symbol('controller'),
      symbol('controller'),
      symbol('repository'),
      symbol('application_service'),
    ];
    expect(inferArchitecturePolicy(doc)).toBe('layered-v1');
  });

  it('defaults to hexagonal-v1 without a sidecar and never infers vertical-v1', () => {
    expect(inferArchitecturePolicy(null)).toBe('hexagonal-v1');
    const doc = emptySidecar('x');
    doc.symbols = [symbol('port'), symbol('adapter'), symbol('controller')];
    expect(inferArchitecturePolicy(doc)).toBe('hexagonal-v1');
  });

  it('writes once and refuses to overwrite', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-init-policy-'));
    dirs.push(root);
    const first = seedArchitecturePolicy({ root, policy: 'hexagonal-v1' });
    expect(first.written).toBe(true);
    expect(first.observed).toBe(0);
    expect(fs.readFileSync(path.join(root, first.path), 'utf8')).toMatch(/vg\.arch\.policy\.v1/);
    const second = seedArchitecturePolicy({ root, policy: 'layered-v1' });
    expect(second.written).toBe(false);
    expect(second.reason).toBe('already-present');
    expect(fs.readFileSync(path.join(root, first.path), 'utf8')).toMatch(/hexagonal-v1/);
  });
});
