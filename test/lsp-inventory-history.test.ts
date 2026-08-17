import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  readInventory,
  recordInventory,
  newlyDrifted,
  inventoryKey,
  inventoryPath,
} from '../src/lsp/inventory-history.js';

// The drifted-dependency snapshot behind the inline "new" marker. Same rules
// as the score history: machine-local, methodology-guarded, best-effort.
describe('inventory history', () => {
  const tmps: string[] = [];
  const mkroot = (): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-inv-'));
    tmps.push(dir);
    return dir;
  };
  afterEach(() => {
    while (tmps.length) fs.rmSync(tmps.pop()!, { recursive: true, force: true });
  });

  it('round-trips a snapshot and gitignores it', () => {
    const root = mkroot();
    const snap = { ts: '2026-08-15T00:00:00Z', methodology: 'driftscore-3.0', drifted: [inventoryKey('.', 'react')] };
    recordInventory(root, snap);
    expect(readInventory(root)).toEqual(snap);
    const gi = fs.readFileSync(path.join(root, '.vibgrate', '.gitignore'), 'utf8');
    expect(gi).toContain('inline-inventory.json');
  });

  it('missing or corrupt snapshot reads as null', () => {
    const root = mkroot();
    expect(readInventory(root)).toBeNull();
    fs.mkdirSync(path.join(root, '.vibgrate'), { recursive: true });
    fs.writeFileSync(inventoryPath(root), 'nope');
    expect(readInventory(root)).toBeNull();
  });

  it('marks only dependencies that were not drifted before', () => {
    const prev = { ts: 't1', methodology: 'driftscore-3.0', drifted: ['.::react'] };
    const cur = { ts: 't2', methodology: 'driftscore-3.0', drifted: ['.::react', '.::axios'] };
    const marked = newlyDrifted(prev, cur);
    expect(marked.has('.::axios')).toBe(true);
    expect(marked.has('.::react')).toBe(false);
  });

  it('no previous snapshot, same timestamp, or a methodology change → no markers', () => {
    const cur = { ts: 't2', methodology: 'driftscore-3.0', drifted: ['.::axios'] };
    expect(newlyDrifted(null, cur).size).toBe(0);
    expect(newlyDrifted({ ...cur }, cur).size).toBe(0);
    expect(newlyDrifted({ ts: 't1', methodology: 'driftscore-2.0', drifted: [] }, cur).size).toBe(0);
  });
});
