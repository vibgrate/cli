import { describe, it, expect } from 'vitest';
import {
  resolveVibgratePaths,
  repositoryIdFromRoot,
  repositoryStoreDir,
  globalGraphPath,
  globalGraphPathForRef,
  daemonDir,
} from './paths.js';
import { branchGraphSnapshotId } from './git-ref.js';

describe('resolveVibgratePaths', () => {
  it('honours explicit env overrides', () => {
    const paths = resolveVibgratePaths(
      {
        VIBGRATE_DATA_DIR: '/tmp/vg-data',
        VIBGRATE_CACHE_DIR: '/tmp/vg-cache',
        VIBGRATE_RUNTIME_DIR: '/tmp/vg-run',
      },
      'linux',
      '/home/dev',
    );
    expect(paths.data).toBe('/tmp/vg-data');
    expect(paths.cache).toBe('/tmp/vg-cache');
    expect(paths.runtime).toBe('/tmp/vg-run');
  });

  it('uses XDG locations on Linux', () => {
    const paths = resolveVibgratePaths({}, 'linux', '/home/dev');
    expect(paths.data).toBe('/home/dev/.local/share/vibgrate');
    expect(paths.cache).toBe('/home/dev/.cache/vibgrate');
    expect(paths.runtime).toBe('/home/dev/.local/state/vibgrate/run');
  });

  it('uses Application Support / Caches on macOS', () => {
    const paths = resolveVibgratePaths({}, 'darwin', '/Users/dev');
    expect(paths.data).toBe('/Users/dev/Library/Application Support/Vibgrate');
    expect(paths.cache).toBe('/Users/dev/Library/Caches/Vibgrate');
    expect(paths.runtime).toBe('/Users/dev/Library/Application Support/Vibgrate/run');
  });

  it('uses LOCALAPPDATA on Windows', () => {
    const paths = resolveVibgratePaths({ LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local' }, 'win32', 'C:\\Users\\dev');
    expect(paths.data.replace(/\\/g, '/')).toMatch(/Vibgrate$/);
    expect(paths.cache.replace(/\\/g, '/')).toMatch(/Vibgrate\/Cache$/);
  });
});

describe('repository store keys', () => {
  it('derives a stable repository id from the root path', () => {
    const a = repositoryIdFromRoot('/repos/app');
    const b = repositoryIdFromRoot('/repos/app');
    const c = repositoryIdFromRoot('/repos/other');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
  });

  it('places graph snapshots under the global data dir', () => {
    const env = { VIBGRATE_DATA_DIR: '/tmp/vg-data' };
    const store = repositoryStoreDir('/repos/app', env, 'linux', '/home/dev');
    expect(store.startsWith('/tmp/vg-data/repos/')).toBe(true);
    expect(globalGraphPath('/repos/app', 'current', env, 'linux', '/home/dev')).toBe(
      `${store}/graphs/current.graph.json`,
    );
  });

  it('places branch-keyed graphs under a distinct snapshot id', () => {
    const env = { VIBGRATE_DATA_DIR: '/tmp/vg-data' };
    const store = repositoryStoreDir('/repos/app', env, 'linux', '/home/dev');
    const p = globalGraphPathForRef('/repos/app', 'feature/x', env, 'linux', '/home/dev');
    expect(p).toBe(`${store}/graphs/${branchGraphSnapshotId('feature/x')}.graph.json`);
    expect(p).not.toContain('/feature/');
  });

  it('puts daemon state under the runtime dir', () => {
    const dir = daemonDir({ VIBGRATE_RUNTIME_DIR: '/tmp/vg-run' }, 'linux', '/home/dev');
    expect(dir).toBe('/tmp/vg-run/daemon');
  });
});
