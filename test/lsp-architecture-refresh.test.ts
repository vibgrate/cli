import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * After a late graph / AST-role refine, `vg lsp` must re-push `vibgrate/score`
 * so the Architecture panel re-pulls. A silent in-memory refine leaves the
 * first session on the path-only snapshot (scan publishes before buildGraph).
 */
describe('LSP architecture refresh after graph refine', () => {
  const src = fs.readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/lsp/server.ts'),
    'utf8',
  );

  function methodBody(marker: string): string {
    const start = src.indexOf(marker);
    expect(start).toBeGreaterThanOrEqual(0);
    const next = src.indexOf('\n  private ', start + marker.length);
    return src.slice(start, next < 0 ? src.length : next);
  }

  it('re-publishes the score after ensureGraph and onRefreshSettled refine roles', () => {
    expect(src).toContain('private refineAndPublishArchitecture()');
    expect(methodBody('private refineAndPublishArchitecture()')).toContain('this.publishScore()');

    const ensure = methodBody('private async ensureGraph()');
    expect(ensure).toContain('this.refineAndPublishArchitecture()');
    expect(ensure).not.toMatch(/if \(this\.artifact\) refineArtifactWithGraph/);

    // A settled refresh reloads through `reloadGraphFromDisk`, which the
    // daemon's `slot-changed` push shares — the re-publish must live there so
    // both routes to a new map re-push the score, not just the local one.
    const refresh = methodBody('private onRefreshSettled(');
    expect(refresh).toContain('this.reloadGraphFromDisk();');
    expect(refresh).not.toMatch(/if \(this\.artifact\) refineArtifactWithGraph/);

    const reload = methodBody('private reloadGraphFromDisk()');
    expect(reload).toContain('this.refineAndPublishArchitecture()');
    expect(reload).not.toMatch(/if \(this\.artifact\) refineArtifactWithGraph/);
  });
});

describe('LSP overlay for a skipped nested manifest', () => {
  const src = fs.readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/lsp/server.ts'),
    'utf8',
  );

  it('scores an open excluded package instead of inheriting the parent overlay', () => {
    expect(src).toContain('private async scanOpenManifest(');
    expect(src).toContain('this.scanOpenManifest(uri, filePath)');
    expect(src).toContain('this package is not in the workspace scan');
  });
});

