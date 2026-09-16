import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bumpDeclaredDependency, patchesFromScanArtifact, patchesFromVersionPairs } from './patches.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('bumpDeclaredDependency', () => {
  const pkg = '{\n  "dependencies": {\n    "left-pad": "^1.0.0"\n  }\n}\n';

  it('bumps a declared version and keeps the range prefix', () => {
    expect(bumpDeclaredDependency(pkg, 'left-pad', '3.0.0')).toContain('"left-pad": "^3.0.0"');
  });

  it('returns null when the package is absent or already current', () => {
    expect(bumpDeclaredDependency(pkg, 'chalk', '5.0.0')).toBeNull();
    expect(bumpDeclaredDependency(pkg, 'left-pad', '1.0.0')).toBeNull();
  });

  it('refuses invalid JSON or a non-version target', () => {
    expect(bumpDeclaredDependency('{', 'left-pad', '3.0.0')).toBeNull();
    expect(bumpDeclaredDependency(pkg, 'left-pad', 'latest')).toBeNull();
  });
});

describe('patchesFromVersionPairs', () => {
  it('writes a real package.json patch when the name is declared', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-review-patch-'));
    dirs.push(root);
    fs.writeFileSync(path.join(root, 'package.json'), '{ "dependencies": { "left-pad": "1.0.0" } }\n');
    const patches = patchesFromVersionPairs(root, [
      { packageName: 'left-pad', fromVersion: '1.0.0', toVersion: '3.0.0' },
    ]);
    expect(patches).toHaveLength(1);
    expect(patches[0]?.after).toContain('"left-pad": "3.0.0"');
    expect(patches[0]?.reason).toMatch(/lockfile/);
  });
});

describe('patchesFromScanArtifact', () => {
  it('reads drifted packages from the on-disk scan artifact', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-review-scan-'));
    dirs.push(root);
    fs.mkdirSync(path.join(root, '.vibgrate'));
    fs.writeFileSync(path.join(root, 'package.json'), '{ "dependencies": { "left-pad": "1.0.0" } }\n');
    fs.writeFileSync(
      path.join(root, '.vibgrate/scan_result.json'),
      JSON.stringify({
        topDependencies: [
          { package: 'left-pad', resolvedVersion: '1.0.0', latestStable: '3.0.0', drift: 'major-behind' },
        ],
      }),
    );
    const patches = patchesFromScanArtifact(root);
    expect(patches[0]?.after).toContain('"left-pad": "3.0.0"');
  });
});
