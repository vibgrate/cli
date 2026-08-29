import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { displayGraphPath } from './artifacts.js';

/**
 * The map normally lives in the global store, outside the repo. Showing that
 * as a repo-relative path yields `../../../home/you/.local/state/…`, which is
 * how `vg status` came to print a line no one could read.
 */
describe('displayGraphPath', () => {
  const root = path.resolve('/repo');

  it('stays repo-relative for an in-repo map', () => {
    expect(displayGraphPath(root, path.join(root, '.vibgrate', 'graph.json'))).toBe(
      path.join('.vibgrate', 'graph.json'),
    );
  });

  it('abbreviates the home directory for a map in the global store', () => {
    const home = path.resolve('/home/dev');
    const p = path.join(home, '.local', 'state', 'vibgrate', 'graph.json');
    expect(displayGraphPath(root, p, home)).toBe(`~${p.slice(home.length)}`);
  });

  it('never emits a climbing relative path', () => {
    const home = path.resolve('/home/dev');
    const p = path.join(home, '.local', 'state', 'vibgrate', 'graph.json');
    expect(displayGraphPath(root, p, home).startsWith('..')).toBe(false);
  });

  it('falls back to the absolute path when it is outside home', () => {
    const p = path.resolve('/var/cache/vibgrate/graph.json');
    expect(displayGraphPath(root, p, path.resolve('/home/dev'))).toBe(p);
  });
});
