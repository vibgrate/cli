import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { loadPackageVersionManifest } from './package-version-manifest.js';

describe('package version manifest loader', () => {
  it('loads JSON manifest files', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'vibgrate-manifest-test-'));
    const manifestPath = path.join(tmpDir, 'package-versions.json');
    await writeFile(manifestPath, JSON.stringify({ npm: { react: { latest: '19.0.0', versions: ['18.3.1', '19.0.0'] } } }));

    const manifest = await loadPackageVersionManifest(manifestPath);
    expect(manifest.npm?.react?.latest).toBe('19.0.0');
  });
});
