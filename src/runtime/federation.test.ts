import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  federationFromWorkspaceRoots,
  isNestedAgentWorktree,
  loadFederation,
  loadOrDiscoverFederation,
  parseFederationFile,
  singleMemberFederation,
  writeFederationFile,
} from './federation.js';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-fed-'));
  dirs.push(d);
  return d;
}

describe('federation', () => {
  it('synthesizes a single-member federation when no file exists', () => {
    const root = tmp();
    const fed = loadFederation(root);
    expect(fed?.members).toHaveLength(1);
    expect(fed?.members[0].role).toBe('primary');
    expect(fed?.members[0].root).toBe(path.resolve(root));
  });

  it('loads multi-root federation.json relative to primary', () => {
    const primary = tmp();
    const shared = tmp();
    fs.mkdirSync(path.join(primary, '.vibgrate'), { recursive: true });
    fs.writeFileSync(
      path.join(primary, '.vibgrate', 'federation.json'),
      JSON.stringify({
        schemaVersion: 'federation/0',
        members: [
          { root: '.', label: 'app', role: 'primary' },
          { root: shared, label: 'shared-lib' },
        ],
      }),
    );
    const fed = loadFederation(primary);
    expect(fed?.members).toHaveLength(2);
    expect(fed?.members.map((m) => m.label).sort()).toEqual(['app', 'shared-lib']);
    expect(fed?.members.find((m) => m.role === 'primary')?.label).toBe('app');
  });

  it('parseFederationFile is deterministic', () => {
    const primary = '/repos/app';
    const a = parseFederationFile(primary, {
      members: [
        { root: '../lib', label: 'lib' },
        { root: '.', role: 'primary', label: 'app' },
      ],
    });
    const b = parseFederationFile(primary, {
      members: [
        { root: '../lib', label: 'lib' },
        { root: '.', role: 'primary', label: 'app' },
      ],
    });
    expect(a).toEqual(b);
    expect(singleMemberFederation(primary).members).toHaveLength(1);
  });

  it('federationFromWorkspaceRoots marks preferred primary and dedupes', () => {
    const a = tmp();
    const b = tmp();
    const fed = federationFromWorkspaceRoots([a, b, a], { preferredPrimary: b });
    expect(fed.primaryRoot).toBe(path.resolve(b));
    expect(fed.members).toHaveLength(2);
    expect(fed.members.find((m) => m.role === 'primary')?.root).toBe(path.resolve(b));
    expect(fed.members.some((m) => m.root === path.resolve(a) && m.role === 'member')).toBe(true);
  });

  it('writeFederationFile round-trips through loadFederation', () => {
    const primary = tmp();
    const shared = tmp();
    const built = federationFromWorkspaceRoots([primary, shared], { preferredPrimary: primary });
    const written = writeFederationFile(primary, built);
    expect(written).toBe(path.join(primary, '.vibgrate', 'federation.json'));
    const loaded = loadFederation(primary, { requireFile: true });
    expect(loaded?.members).toHaveLength(2);
    expect(loaded?.primaryRoot).toBe(path.resolve(primary));
    expect(loaded?.members.map((m) => m.root).sort()).toEqual(
      [path.resolve(primary), path.resolve(shared)].sort(),
    );
  });

  it('loadOrDiscoverFederation discovers package workspaces and bridges', () => {
    const primary = tmp();
    const pkgA = path.join(primary, 'packages', 'a');
    const pkgB = path.join(primary, 'packages', 'b');
    fs.mkdirSync(pkgA, { recursive: true });
    fs.mkdirSync(pkgB, { recursive: true });
    fs.writeFileSync(
      path.join(primary, 'package.json'),
      JSON.stringify({ name: 'root', workspaces: ['packages/*'] }),
    );
    fs.writeFileSync(
      path.join(pkgA, 'package.json'),
      JSON.stringify({ name: '@m/a', dependencies: { '@m/b': 'workspace:*' } }),
    );
    fs.writeFileSync(path.join(pkgB, 'package.json'), JSON.stringify({ name: '@m/b' }));

    const fed = loadOrDiscoverFederation(primary);
    expect(fed.members.length).toBeGreaterThanOrEqual(3); // primary + a + b
    expect(fed.bridges?.some((b) => b.packageName === '@m/b' && b.confidence >= 0.9)).toBe(true);
  });

  it('drops agent worktrees nested under a hidden folder of the primary', () => {
    const primary = tmp();
    const worktree = path.join(primary, '.claude', 'worktrees', 'agent');
    fs.mkdirSync(worktree, { recursive: true });
    expect(isNestedAgentWorktree(worktree, primary)).toBe(true);
    const fed = federationFromWorkspaceRoots([primary, worktree], { preferredPrimary: primary });
    expect(fed.members.map((m) => m.root)).toEqual([path.resolve(primary)]);
    const loaded = parseFederationFile(primary, {
      members: [
        { root: '.', role: 'primary', label: 'app' },
        { root: '.claude/worktrees/agent', label: 'claude-wt' },
        { root: '.cursor/worktrees/agent', label: 'cursor-wt' },
      ],
    });
    expect(loaded?.members.map((m) => m.label)).toEqual(['app']);
  });
});
