/**
 * NuGet `packages.lock.json` as a full SBOM graph: Direct and Transitive
 * packages, one row per id and version across target frameworks, Project
 * entries left out, contentHash as SHA-512, and edges from `dependencies`.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fullDependencyGraph, type LockfileGraph } from './lockfile.js';

const SHA512 = createHash('sha512').update('newtonsoft-json-bson').digest('base64');
const MEMORY_HASH = createHash('sha512').update('system-memory').digest('base64');
const TOKEN = 'super-secret-nuget-token';

function framework(order: 'v6-first' | 'v8-first'): Record<string, unknown> {
  const v6 = {
    'newtonsoft.json': {
      type: 'Direct',
      requested: '[13.0.3, )',
      resolved: '13.0.3',
      contentHash: TOKEN,
      dependencies: {
        'Newtonsoft.Json.Bson': '[1.0.2, )',
        'Missing.Package': '9.9.9',
      },
    },
    'system.memory': {
      type: 'Transitive',
      resolved: '4.5.5',
      contentHash: MEMORY_HASH,
    },
    Serilog: {
      type: 'Transitive',
      resolved: '3.1.1',
    },
    'App.Tests': {
      type: 'Project',
      resolved: '1.0.0',
      contentHash: MEMORY_HASH,
    },
  };
  const v8 = {
    'Newtonsoft.Json': {
      type: 'Direct',
      requested: '[13.0.3, )',
      resolved: '13.0.3',
      dependencies: {
        'newtonsoft.json.bson': '1.0.2',
      },
    },
    'System.Memory': {
      type: 'Transitive',
      resolved: '4.5.5',
      contentHash: MEMORY_HASH,
    },
    Serilog: {
      type: 'Transitive',
      resolved: '4.0.0',
    },
    'Newtonsoft.Json.Bson': {
      type: 'Transitive',
      resolved: '1.0.2',
      contentHash: SHA512,
    },
  };
  const v6Key = '.NETCoreApp,Version=v6.0';
  const v8Key = '.NETCoreApp,Version=v8.0';
  return order === 'v6-first' ? { [v6Key]: v6, [v8Key]: v8 } : { [v8Key]: v8, [v6Key]: v6 };
}

function snapshot(graph: LockfileGraph | undefined) {
  return {
    ecosystem: graph?.ecosystem,
    components: graph?.components,
    rootDependsOn: graph?.rootDependsOn,
    edges: [...(graph?.edges?.entries() ?? [])].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  };
}

describe('fullDependencyGraph — packages.lock.json', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-nuget-lock-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function writeLock(order: 'v6-first' | 'v8-first'): void {
    fs.writeFileSync(
      path.join(root, 'packages.lock.json'),
      JSON.stringify({ version: 1, dependencies: framework(order) }),
    );
  }

  it('lists Direct and Transitive packages, skips Project, and records SHA-512 edges', () => {
    writeLock('v6-first');
    const graph = fullDependencyGraph(root);
    expect(graph?.ecosystem).toBe('dotnet');
    expect(graph?.components).toEqual([
      { package: 'Newtonsoft.Json', version: '13.0.3' },
      {
        package: 'Newtonsoft.Json.Bson',
        version: '1.0.2',
        digests: [{ alg: 'SHA-512', content: SHA512 }],
      },
      { package: 'Serilog', version: '3.1.1' },
      { package: 'Serilog', version: '4.0.0' },
      {
        package: 'System.Memory',
        version: '4.5.5',
        digests: [{ alg: 'SHA-512', content: MEMORY_HASH }],
      },
    ]);
    expect(graph?.components.some((row) => row.package === 'App.Tests')).toBe(false);
    expect(graph?.rootDependsOn).toEqual(['Newtonsoft.Json@13.0.3']);
    expect(graph?.edges?.get('Newtonsoft.Json@13.0.3')).toEqual(['Newtonsoft.Json.Bson@1.0.2']);
    expect(graph?.edges?.get('Newtonsoft.Json.Bson@1.0.2')).toEqual([]);
    expect(JSON.stringify(graph?.components)).not.toContain(TOKEN);
  });

  it('merges the same id and version across target frameworks, independent of framework order', () => {
    writeLock('v6-first');
    const first = snapshot(fullDependencyGraph(root));
    fs.rmSync(path.join(root, 'packages.lock.json'));
    writeLock('v8-first');
    const second = snapshot(fullDependencyGraph(root));
    expect(second).toEqual(first);

    const memory = first.components?.filter((row) => row.package.toLowerCase() === 'system.memory');
    expect(memory).toEqual([
      {
        package: 'System.Memory',
        version: '4.5.5',
        digests: [{ alg: 'SHA-512', content: MEMORY_HASH }],
      },
    ]);
    const json = first.components?.filter((row) => row.package.toLowerCase() === 'newtonsoft.json');
    expect(json).toEqual([{ package: 'Newtonsoft.Json', version: '13.0.3' }]);
  });

  it('returns undefined when the file lists only Project entries', () => {
    fs.writeFileSync(
      path.join(root, 'packages.lock.json'),
      JSON.stringify({
        version: 1,
        dependencies: {
          'net8.0': {
            'App.Tests': { type: 'Project' },
          },
        },
      }),
    );
    expect(fullDependencyGraph(root)).toBeUndefined();
  });
});
