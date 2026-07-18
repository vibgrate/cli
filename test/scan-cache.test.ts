import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import { manifestHash, loadScanCache, writeScanCache } from '../src/lsp/scan-cache.js';
import { makeProject, cleanup } from './helpers.js';
import type { ScanArtifact } from '../src/core-open/index.js';

describe('manifestHash', () => {
  it('is stable when no manifest/lockfile content changed', () => {
    const dir = makeProject({
      'package.json': JSON.stringify({ name: 'x', dependencies: { 'left-pad': '1.0.0' } }),
      'src/index.ts': 'export const x = 1;',
    });
    try {
      expect(manifestHash(dir)).toBe(manifestHash(dir));
    } finally {
      cleanup(dir);
    }
  });

  it('changes when a manifest is edited', () => {
    const dir = makeProject({ 'package.json': JSON.stringify({ name: 'x', version: '1.0.0' }) });
    try {
      const before = manifestHash(dir);
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '2.0.0' }));
      expect(manifestHash(dir)).not.toBe(before);
    } finally {
      cleanup(dir);
    }
  });

  it('is unaffected by a non-manifest source file changing', () => {
    const dir = makeProject({
      'package.json': JSON.stringify({ name: 'x', version: '1.0.0' }),
      'src/index.ts': 'export const x = 1;',
    });
    try {
      const before = manifestHash(dir);
      fs.writeFileSync(path.join(dir, 'src/index.ts'), 'export const x = 2;');
      expect(manifestHash(dir)).toBe(before);
    } finally {
      cleanup(dir);
    }
  });

  it('ignores node_modules', () => {
    const dir = makeProject({
      'package.json': JSON.stringify({ name: 'x', version: '1.0.0' }),
      'node_modules/left-pad/package.json': JSON.stringify({ name: 'left-pad', version: '1.0.0' }),
    });
    try {
      const before = manifestHash(dir);
      fs.writeFileSync(
        path.join(dir, 'node_modules/left-pad/package.json'),
        JSON.stringify({ name: 'left-pad', version: '9.9.9' }),
      );
      expect(manifestHash(dir)).toBe(before);
    } finally {
      cleanup(dir);
    }
  });
});

describe('scan cache round-trip', () => {
  const key = { manifestHash: 'hash-1', toolVersion: '1.0.0', offline: false };

  it('returns null before anything is written', () => {
    const dir = makeProject({ 'package.json': '{}' });
    try {
      expect(loadScanCache(dir, key)).toBeNull();
    } finally {
      cleanup(dir);
    }
  });

  it('reads back exactly what was written', () => {
    const dir = makeProject({ 'package.json': '{}' });
    try {
      const artifact = { rootPath: '.', timestamp: '2020-01-01T00:00:00.000Z' } as unknown as ScanArtifact;
      writeScanCache(dir, key, artifact);
      const loaded = loadScanCache(dir, key);
      expect(loaded?.manifestHash).toBe('hash-1');
      expect(loaded?.artifact.rootPath).toBe('.');
    } finally {
      cleanup(dir);
    }
  });

  it('misses when the manifest hash no longer matches', () => {
    const dir = makeProject({ 'package.json': '{}' });
    try {
      writeScanCache(dir, key, { rootPath: '.' } as unknown as ScanArtifact);
      expect(loadScanCache(dir, { ...key, manifestHash: 'hash-2' })).toBeNull();
    } finally {
      cleanup(dir);
    }
  });

  it('misses when the tool version changed (e.g. an engine upgrade)', () => {
    const dir = makeProject({ 'package.json': '{}' });
    try {
      writeScanCache(dir, key, { rootPath: '.' } as unknown as ScanArtifact);
      expect(loadScanCache(dir, { ...key, toolVersion: '2.0.0' })).toBeNull();
    } finally {
      cleanup(dir);
    }
  });

  it('misses when the offline flag changed', () => {
    const dir = makeProject({ 'package.json': '{}' });
    try {
      writeScanCache(dir, key, { rootPath: '.' } as unknown as ScanArtifact);
      expect(loadScanCache(dir, { ...key, offline: true })).toBeNull();
    } finally {
      cleanup(dir);
    }
  });
});
