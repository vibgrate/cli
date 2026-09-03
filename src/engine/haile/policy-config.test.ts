import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { architecturePolicyFor, isHailePolicy } from './policy-config.js';

describe('architecturePolicyFor', () => {
  const dirs: string[] = [];
  const saved = process.env.VIBGRATE_ARCHITECTURE_POLICY;
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
    if (saved === undefined) delete process.env.VIBGRATE_ARCHITECTURE_POLICY;
    else process.env.VIBGRATE_ARCHITECTURE_POLICY = saved;
  });
  const tmp = (): string => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-policy-'));
    dirs.push(d);
    return d;
  };

  it('defaults to hexagonal-v1 with no file, and a typo never turns into an error', () => {
    delete process.env.VIBGRATE_ARCHITECTURE_POLICY;
    const root = tmp();
    expect(architecturePolicyFor(root)).toBe('hexagonal-v1');
    fs.mkdirSync(path.join(root, '.vibgrate'));
    fs.writeFileSync(path.join(root, '.vibgrate', 'architecture.toml'), 'policy = "onion-v9"\n');
    expect(architecturePolicyFor(root)).toBe('hexagonal-v1');
    fs.writeFileSync(path.join(root, '.vibgrate', 'architecture.toml'), 'policy = = broken');
    expect(architecturePolicyFor(root)).toBe('hexagonal-v1');
  });

  it('reads the file, lets the environment override it, and the flag override both', () => {
    delete process.env.VIBGRATE_ARCHITECTURE_POLICY;
    const root = tmp();
    fs.mkdirSync(path.join(root, '.vibgrate'));
    fs.writeFileSync(path.join(root, '.vibgrate', 'architecture.toml'), '# rules for this repo\npolicy = "layered-v1"\n');
    expect(architecturePolicyFor(root)).toBe('layered-v1');
    process.env.VIBGRATE_ARCHITECTURE_POLICY = 'hexagonal-v1';
    expect(architecturePolicyFor(root)).toBe('hexagonal-v1');
    expect(architecturePolicyFor(root, 'layered-v1')).toBe('layered-v1');
    expect(architecturePolicyFor(root, 'nonsense')).toBe('hexagonal-v1');
    expect(isHailePolicy('layered-v1')).toBe(true);
    expect(isHailePolicy('')).toBe(false);
  });
});
