import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { projectForFile } from './project-for-file.js';

const root = path.resolve('/repo');
const projects = [{ path: '.' }, { path: 'packages/core' }, { path: 'packages/mcp' }];

describe('projectForFile', () => {
  it('matches a nested package.json to that package, not the repo root', () => {
    const hit = projectForFile(root, projects, path.join(root, 'packages/mcp/package.json'));
    expect(hit?.path).toBe('packages/mcp');
  });

  it('matches the root package.json to the root project', () => {
    const hit = projectForFile(root, projects, path.join(root, 'package.json'));
    expect(hit?.path).toBe('.');
  });

  it('does not inherit the parent score onto an excluded nested manifest', () => {
    const scanned = [{ path: '.' }, { path: 'packages/core' }];
    const hit = projectForFile(root, scanned, path.join(root, 'packages/mcp/package.json'));
    expect(hit).toBeUndefined();
  });

  it('still uses longest-prefix for non-manifest files inside a scanned project', () => {
    const hit = projectForFile(root, projects, path.join(root, 'packages/mcp/src/index.ts'));
    expect(hit?.path).toBe('packages/mcp');
  });
});
