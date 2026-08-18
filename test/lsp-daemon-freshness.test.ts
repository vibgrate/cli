import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * `vg lsp` and `vg serve` both used to watch the workspace and rebuild the map
 * themselves, alongside the daemon already doing both — three processes
 * noticing one edit. They may now stand down, but only under conditions that
 * cannot leave a workspace with *nobody* watching it.
 *
 * These are source invariants rather than a live daemon test on purpose: the
 * failure being guarded against is an ordering/conditional mistake in the
 * stand-down, which is exactly what survives a green integration run on a
 * machine that happens to have a healthy daemon.
 */
describe('vg lsp defers freshness to the daemon only when it is real', () => {
  const src = fs.readFileSync(path.resolve(here, '../src/lsp/server.ts'), 'utf8');

  function methodBody(marker: string): string {
    const start = src.indexOf(marker);
    expect(start).toBeGreaterThanOrEqual(0);
    const next = src.indexOf('\n  private ', start + marker.length);
    return src.slice(start, next < 0 ? src.length : next);
  }

  const defer = methodBody('private async deferFreshnessToDaemon()');

  it('skips the local probe only while the daemon owns freshness', () => {
    const query = methodBody('private async graphForQuery()');
    expect(query).toContain('if (!this.daemonOwnsFreshness) await this.refresher.maybeRefresh();');
  });

  it('publishes the map before subscribing, so the daemon is actually watching', () => {
    // The daemon starts watching a repo when it holds that repo's slot.
    // Subscribing first would acknowledge a subscription that never pushes.
    const publishAt = defer.indexOf('publishGraphToVgd(this.opts.root)');
    const subscribeAt = defer.indexOf('subscribeToSlots({');
    expect(publishAt).toBeGreaterThanOrEqual(0);
    expect(subscribeAt).toBeGreaterThan(publishAt);
  });

  it('gives up unless the daemon took the map', () => {
    expect(defer).toContain("if (published.status !== 'published' && published.status !== 'current') return;");
  });

  it('scopes the subscription to this repository', () => {
    expect(defer).toContain('repositoryId,');
  });

  it('retires the local probe only after the daemon confirms the subscription', () => {
    const confirmAt = defer.indexOf('if (!subscription.active) return;');
    const standDownAt = defer.indexOf('this.daemonOwnsFreshness = true;');
    expect(confirmAt).toBeGreaterThanOrEqual(0);
    expect(standDownAt).toBeGreaterThan(confirmAt);
  });

  it('resumes watching for itself when the connection drops', () => {
    expect(defer).toContain('onDetach: () => {');
    expect(defer).toContain('this.daemonOwnsFreshness = false;');
    expect(defer).toContain('this.slotSubscription = null;');
  });

  it('never reaches for the daemon under --no-daemon or --no-graph', () => {
    expect(defer).toContain("if (this.opts.daemon === false || !this.opts.graph) return;");
  });

  it('swallows every daemon failure — no daemon is a supported configuration', () => {
    // The slice runs to the next member, so anchor on the catch itself rather
    // than the end of the string.
    expect(defer).toMatch(/\} catch \{\s*\/\* No daemon/);
    expect(defer).not.toContain('throw');
  });

  it('closes the subscription on shutdown so it cannot outlive the server', () => {
    expect(src).toContain('this.slotSubscription?.close();');
    // A shutdown racing a still-connecting socket must not leak it either.
    expect(defer).toContain('if (this.shuttingDown) {');
    expect(defer).toContain('subscription.close();');
  });

  it('reloads from disk on a pushed change, sharing the local refresh path', () => {
    expect(defer).toContain('onChange: () => this.reloadGraphFromDisk()');
    expect(methodBody('private onRefreshSettled(')).toContain('this.reloadGraphFromDisk();');
    expect(methodBody('private reloadGraphFromDisk()')).toContain('this.refineAndPublishArchitecture();');
  });
});

describe('vg serve defers freshness to the daemon only when it is real', () => {
  const src = fs.readFileSync(path.resolve(here, '../src/mcp/server.ts'), 'utf8');
  const start = src.indexOf('async function watchViaDaemonOrLocally(');
  const fn = src.slice(start, src.indexOf('\nexport function createServer(', start));

  it('publishes before subscribing', () => {
    expect(start).toBeGreaterThanOrEqual(0);
    const publishAt = fn.indexOf('publishGraphToVgd(');
    const subscribeAt = fn.indexOf('subscribeToSlots({');
    expect(publishAt).toBeGreaterThanOrEqual(0);
    expect(subscribeAt).toBeGreaterThan(publishAt);
  });

  it('scopes the subscription to the published repository', () => {
    expect(fn).toContain('repositoryId: published.repositoryId,');
  });

  it('falls back to its own watcher on every other path', () => {
    // --no-daemon, no daemon running, refused map, unconfirmed subscription.
    expect(fn).toContain('source.startWatching();');
    expect(fn.match(/source\.startWatching\(\);/g)?.length).toBeGreaterThanOrEqual(2);
    expect(fn).toContain('onDetach: () => source.resumeLocalFreshness(),');
  });

  it('stands down only on a confirmed subscription', () => {
    const confirmAt = fn.indexOf('if (subscription.active) {');
    const standDownAt = fn.indexOf('source.deferFreshnessToDaemon();');
    expect(confirmAt).toBeGreaterThanOrEqual(0);
    expect(standDownAt).toBeGreaterThan(confirmAt);
  });
});
