import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  discoverBridgeEdges,
  highConfidenceBridges,
  parsePackageManifest,
  BRIDGE_EDGE_SCHEMA_VERSION,
} from './bridge-edges.js';

describe('discoverBridgeEdges', () => {
  it('links workspace:* dependencies between members with high confidence', () => {
    const members = [{ root: '/mono/packages/a' }, { root: '/mono/packages/b' }];
    const manifests: Record<string, string> = {
      '/mono/packages/a': JSON.stringify({
        name: '@m/a',
        dependencies: { '@m/b': 'workspace:*' },
      }),
      '/mono/packages/b': JSON.stringify({ name: '@m/b' }),
    };
    const edges = discoverBridgeEdges(members, (root) => parsePackageManifest(manifests[root] ?? ''));
    expect(edges).toHaveLength(1);
    expect(edges[0]?.schemaVersion).toBe(BRIDGE_EDGE_SCHEMA_VERSION);
    expect(edges[0]?.packageName).toBe('@m/b');
    expect(edges[0]?.kind).toBe('workspace-package');
    expect(edges[0]?.confidence).toBeGreaterThanOrEqual(0.9);
    expect(edges[0]?.fromRoot).toBe(path.resolve('/mono/packages/a'));
    expect(edges[0]?.toRoot).toBe(path.resolve('/mono/packages/b'));
    expect(highConfidenceBridges(edges)).toHaveLength(1);
  });

  it('is deterministic and ignores unknown packages', () => {
    const members = [{ root: '/x' }, { root: '/y' }];
    const read = (root: string) => {
      if (root === path.resolve('/x')) {
        return parsePackageManifest(
          JSON.stringify({ name: 'x', dependencies: { lodash: '^4.0.0', y: 'workspace:^' } }),
        );
      }
      if (root === path.resolve('/y')) return parsePackageManifest(JSON.stringify({ name: 'y' }));
      return null;
    };
    const a = discoverBridgeEdges(members, read);
    const b = discoverBridgeEdges(members, read);
    expect(a).toEqual(b);
    expect(a).toHaveLength(1);
    expect(a[0]?.packageName).toBe('y');
  });

  it('classifies file: deps as path-dependency', () => {
    const members = [{ root: '/app' }, { root: '/lib' }];
    const edges = discoverBridgeEdges(members, (root) => {
      if (root === path.resolve('/app')) {
        return parsePackageManifest(
          JSON.stringify({ name: 'app', dependencies: { lib: 'file:../lib' } }),
        );
      }
      return parsePackageManifest(JSON.stringify({ name: 'lib' }));
    });
    expect(edges[0]?.kind).toBe('path-dependency');
    expect(edges[0]?.confidence).toBeGreaterThanOrEqual(0.75);
  });
});
