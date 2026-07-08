import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { analyzeTree } from './usage.js';

let dir: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-usage-'));
  fs.writeFileSync(path.join(dir, 'a.ts'), `import { useState } from 'react';\nimport axios from 'axios';\n`);
  fs.writeFileSync(path.join(dir, 'b.tsx'), `import { useEffect } from 'react';\n`);
  fs.writeFileSync(path.join(dir, 'c.py'), `from flask import Flask\n`);
  fs.mkdirSync(path.join(dir, 'node_modules', 'react'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'react', 'index.js'), `import { useState } from 'react';\n`);
});

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('analyzeTree', () => {
  it('counts import sites across files and collects contracts in one pass', () => {
    const usage = analyzeTree(dir, [
      { name: 'react', ecosystem: 'npm' },
      { name: 'axios', ecosystem: 'npm' },
      { name: 'flask', ecosystem: 'pypi' },
    ]);
    const react = usage.get('react')!;
    expect(react.filesTouched).toBe(2); // a.ts + b.tsx, NOT node_modules
    expect(react.contracts).toEqual(['useEffect', 'useState']);
    expect(usage.get('axios')!.contracts).toEqual(['default']);
    expect(usage.get('flask')!.contracts).toEqual(['Flask']);
  });

  it('returns empty usage for unknown-ecosystem packages', () => {
    const usage = analyzeTree(dir, [{ name: 'some-gem', ecosystem: 'unknown' }]);
    expect(usage.get('some-gem')).toEqual({ importSites: 0, filesTouched: 0, contracts: [] });
  });

  it('is deterministic', () => {
    const packages = [{ name: 'react', ecosystem: 'npm' as const }];
    expect(analyzeTree(dir, packages)).toEqual(analyzeTree(dir, packages));
  });
});
