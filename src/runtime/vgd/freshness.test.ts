import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FreshnessSupervisor } from './freshness.js';

/**
 * The daemon must never rebuild on its own event loop, never stack rebuilds,
 * and never turn its own output into the next trigger. These pin all three,
 * plus the branch path — where a warm snapshot must win over a rebuild.
 */

interface Harness {
  fire: (dir: 'source' | 'head', filename: string) => void;
  rebuilds: string[];
  reloads: Array<{ repositoryId: string; gitRef: string }>;
  selects: Array<{ repositoryId: string; gitRef: string }>;
  logs: string[];
  sup: FreshnessSupervisor;
  closed: number;
}

function harness(
  opts: {
    reload?: (repositoryId: string, root: string, gitRef: string) => Promise<number | null>;
    rebuild?: (root: string) => Promise<{ ok: boolean; error?: string }>;
    ref?: () => string;
  } = {},
): Harness {
  const handlers: Record<string, (f: string) => void> = {};
  const h: Harness = {
    fire: (dir, filename) => handlers[dir]?.(filename),
    rebuilds: [],
    reloads: [],
    selects: [],
    logs: [],
    closed: 0,
    sup: null as unknown as FreshnessSupervisor,
  };
  h.sup = new FreshnessSupervisor({
    log: (m) => h.logs.push(m),
    settleMs: 5,
    minRebuildGapMs: 0,
    reload: async (repositoryId, root, gitRef) => {
      h.reloads.push({ repositoryId, gitRef });
      return opts.reload ? opts.reload(repositoryId, root, gitRef) : 42;
    },
    select: (repositoryId, gitRef) => h.selects.push({ repositoryId, gitRef }),
    watch: (dir, onChange) => {
      handlers[dir.endsWith('.git') ? 'head' : 'source'] = onChange;
      return {
        close: () => {
          h.closed++;
        },
      };
    },
    rebuild: async (root) => {
      h.rebuilds.push(root);
      return opts.rebuild ? opts.rebuild(root) : { ok: true };
    },
    detectRef: () => (opts.ref ? opts.ref() : 'main'),
  });
  return h;
}

const settle = (ms = 40): Promise<void> => new Promise((r) => setTimeout(r, ms));

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'vgd-fresh-'));
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('FreshnessSupervisor — triggers', () => {
  it('rebuilds after a source edit, then reloads the slot', async () => {
    const h = harness();
    h.sup.start('repo1', root, 'main');

    h.fire('source', 'src/a.ts');
    await settle();

    expect(h.rebuilds).toEqual([root]);
    expect(h.reloads).toEqual([{ repositoryId: 'repo1', gitRef: 'main' }]);
  });

  it('rebuilds on a lockfile edit and says so', async () => {
    const h = harness();
    h.sup.start('repo1', root, 'main');

    h.fire('source', 'pnpm-lock.yaml');
    await settle();

    expect(h.rebuilds).toHaveLength(1);
    expect(h.logs.some((l) => l.includes('(manifest'))).toBe(true);
  });

  it('ignores its own artifacts, or every rebuild would trigger the next', async () => {
    const h = harness();
    h.sup.start('repo1', root, 'main');

    h.fire('source', '.vibgrate/graph.json');
    h.fire('source', 'node_modules/x/index.js');
    h.fire('source', 'dist/bundle.js');
    await settle();

    expect(h.rebuilds).toEqual([]);
  });

  it('coalesces a burst of edits into one rebuild', async () => {
    const h = harness();
    h.sup.start('repo1', root, 'main');

    for (let i = 0; i < 20; i++) h.fire('source', `src/f${i}.ts`);
    await settle();

    expect(h.rebuilds).toHaveLength(1);
    expect(h.logs.some((l) => l.includes('20 file(s)'))).toBe(true);
  });
});

describe('FreshnessSupervisor — never stacks work', () => {
  it('queues exactly one follow-up when edits land mid-rebuild', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const h = harness({
      rebuild: async () => {
        calls++;
        if (calls === 1) await gate;
        return { ok: true };
      },
    });
    h.sup.start('repo1', root, 'main');

    h.fire('source', 'src/a.ts');
    await settle(20);
    // Three more edits while the first rebuild is still running.
    h.fire('source', 'src/b.ts');
    h.fire('source', 'src/c.ts');
    h.fire('source', 'src/d.ts');
    release();
    await settle(60);

    expect(h.rebuilds).toHaveLength(2);
  });

  it('keeps the previous map when a rebuild fails, and does not reload', async () => {
    const h = harness({ rebuild: async () => ({ ok: false, error: 'vg build exited 1' }) });
    h.sup.start('repo1', root, 'main');

    h.fire('source', 'src/a.ts');
    await settle();

    expect(h.reloads).toEqual([]);
    expect(h.logs.some((l) => l.includes('keeps its previous map'))).toBe(true);
  });

  it('survives a rebuild that throws', async () => {
    const h = harness({
      rebuild: async () => {
        throw new Error('spawn EACCES');
      },
    });
    h.sup.start('repo1', root, 'main');

    h.fire('source', 'src/a.ts');
    await settle();

    expect(h.logs.some((l) => l.includes('spawn EACCES'))).toBe(true);
    // And it is not wedged: the next edit still schedules.
    h.fire('source', 'src/b.ts');
    await settle();
    expect(h.rebuilds.length).toBeGreaterThanOrEqual(2);
  });
});

describe('FreshnessSupervisor — branch switches', () => {
  it('re-selects and uses a warm snapshot rather than rebuilding', async () => {
    const h = harness({ reload: async () => 1234, ref: () => 'feature' });
    h.sup.start('repo1', root, 'main');

    h.fire('head', 'HEAD');
    await settle();

    expect(h.selects).toEqual([{ repositoryId: 'repo1', gitRef: 'feature' }]);
    expect(h.rebuilds).toEqual([]);
    expect(h.logs.some((l) => l.includes('slot warm from disk'))).toBe(true);
  });

  it('rebuilds only when the new ref has no snapshot', async () => {
    const h = harness({ reload: async () => null, ref: () => 'feature' });
    h.sup.start('repo1', root, 'main');

    h.fire('head', 'HEAD');
    await settle();

    expect(h.selects).toEqual([{ repositoryId: 'repo1', gitRef: 'feature' }]);
    expect(h.rebuilds).toEqual([root]);
  });

  it('does nothing when HEAD moves but the ref is unchanged (a commit, not a checkout)', async () => {
    const h = harness({ ref: () => 'main' });
    h.sup.start('repo1', root, 'main');

    h.fire('head', 'HEAD');
    await settle();

    expect(h.selects).toEqual([]);
    expect(h.rebuilds).toEqual([]);
  });

  it('ignores non-HEAD churn inside .git', async () => {
    const h = harness({ ref: () => 'feature' });
    h.sup.start('repo1', root, 'main');

    h.fire('head', 'index.lock');
    h.fire('head', 'refs/heads/main');
    await settle();

    expect(h.selects).toEqual([]);
    expect(h.rebuilds).toEqual([]);
  });
});

describe('FreshnessSupervisor — lifecycle', () => {
  it('closes both watchers on stop and stops reacting', async () => {
    const h = harness();
    h.sup.start('repo1', root, 'main');
    h.sup.stop('repo1');

    expect(h.closed).toBe(2);
    expect(h.sup.list()).toEqual([]);
  });

  it('is idempotent — re-registering only refreshes the ref it believes current', () => {
    const h = harness();
    h.sup.start('repo1', root, 'main');
    h.sup.start('repo1', root, 'release');

    expect(h.sup.list()).toHaveLength(1);
    expect(h.sup.list()[0]?.gitRef).toBe('release');
  });

  it('reports what it is watching', async () => {
    const h = harness();
    h.sup.start('repo1', root, 'main');

    expect(h.sup.list()[0]).toMatchObject({ repositoryId: 'repo1', gitRef: 'main', watching: true, building: false });
  });
});
