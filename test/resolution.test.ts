import { describe, it, expect, afterEach } from 'vitest';
import { buildGraph } from '../src/engine/build.js';
import { makeProject, cleanup } from './helpers.js';
import type { EdgeKind, VgGraph } from '../src/schema.js';

/**
 * Cross-language heuristic resolution: precision (no false positives) plus the
 * reachability rungs that actually connect real Python/Java/Go layouts —
 * relative imports, src-layout suffix matching, and same-package visibility.
 * These run on non-TS languages where the tsc rung does not apply.
 */

const PIN = '2020-01-01T00:00:00.000Z';
const dirs: string[] = [];
function project(files: Record<string, string>): string {
  const d = makeProject(files);
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) cleanup(dirs.pop()!);
});

function hasEdge(graph: VgGraph, kind: EdgeKind, srcName: string, dstName: string): boolean {
  const nameById = new Map(graph.nodes.map((n) => [n.id, n.name]));
  return graph.edges.some(
    (e) => e.kind === kind && nameById.get(e.src) === srcName && nameById.get(e.dst) === dstName,
  );
}

describe('heuristic precision (no false positives)', () => {
  it('does NOT link a call to a same-named def that is not import-reachable (Python)', async () => {
    const { graph } = await buildGraph({
      root: project({
        // The ONLY `helper` in the repo lives here…
        'a/util.py': 'def helper():\n    return 1\n',
        // …but b/run.py never imports it — the old global-single-match rung would
        // have wrongly linked these. Honest non-resolution is required.
        'b/run.py': 'def go():\n    return helper()\n',
      }),
      generatedAt: PIN,
      inline: true,
    });
    expect(hasEdge(graph, 'call', 'go', 'helper')).toBe(false);
  });

  it('does NOT link a call into a test file from product code', async () => {
    const { graph } = await buildGraph({
      root: project({
        'svc/prod.py': 'def process():\n    return get()\n',
        'tests/test_fake.py': 'def get():\n    return 1\n',
      }),
      generatedAt: PIN,
      inline: true,
    });
    expect(hasEdge(graph, 'call', 'process', 'get')).toBe(false);
  });
});

describe('Python cross-file resolution', () => {
  it('resolves a relative import (from .models import Base) for heritage', async () => {
    const { graph } = await buildGraph({
      root: project({
        'pkg/__init__.py': '',
        'pkg/models.py': 'class Base:\n    pass\n',
        'pkg/service.py': 'from .models import Base\n\nclass Svc(Base):\n    pass\n',
      }),
      generatedAt: PIN,
      inline: true,
    });
    expect(hasEdge(graph, 'extends', 'Svc', 'Base')).toBe(true);
  });

  it('resolves an absolute dotted import call', async () => {
    const { graph } = await buildGraph({
      root: project({
        'app/util.py': 'def helper():\n    return 1\n',
        'app/main.py': 'from app.util import helper\n\ndef run():\n    return helper()\n',
      }),
      generatedAt: PIN,
      inline: true,
    });
    expect(hasEdge(graph, 'call', 'run', 'helper')).toBe(true);
  });

  it('resolves a src-layout import by path suffix (per-subproject src/ root)', async () => {
    const { graph } = await buildGraph({
      root: project({
        // File lives under svc/src/pkg, imported as `src.pkg.util` (PYTHONPATH=svc).
        'svc/src/pkg/util.py': 'def helper():\n    return 1\n',
        'svc/src/pkg/main.py': 'from src.pkg.util import helper\n\ndef run():\n    return helper()\n',
      }),
      generatedAt: PIN,
      inline: true,
    });
    expect(hasEdge(graph, 'call', 'run', 'helper')).toBe(true);
  });
});

describe('package-scoped resolution (no import needed)', () => {
  it('resolves a same-package call across Go files', async () => {
    const { graph } = await buildGraph({
      root: project({
        'svc/a.go': 'package svc\n\nfunc Helper() int { return 1 }\n',
        'svc/b.go': 'package svc\n\nfunc Run() int { return Helper() }\n',
      }),
      generatedAt: PIN,
      inline: true,
    });
    expect(hasEdge(graph, 'call', 'Run', 'Helper')).toBe(true);
  });

  it('resolves Java heritage via a package import (suffix match)', async () => {
    const { graph } = await buildGraph({
      root: project({
        'src/com/a/Base.java': 'package com.a;\npublic class Base {}\n',
        'src/com/b/Svc.java': 'package com.b;\nimport com.a.Base;\npublic class Svc extends Base {}\n',
      }),
      generatedAt: PIN,
      inline: true,
    });
    expect(hasEdge(graph, 'extends', 'Svc', 'Base')).toBe(true);
  });

  it('resolves Java heritage within the same package (same directory, no import)', async () => {
    const { graph } = await buildGraph({
      root: project({
        'src/com/a/Base.java': 'package com.a;\npublic class Base {}\n',
        'src/com/a/Svc.java': 'package com.a;\npublic class Svc extends Base {}\n',
      }),
      generatedAt: PIN,
      inline: true,
    });
    expect(hasEdge(graph, 'extends', 'Svc', 'Base')).toBe(true);
  });
});
