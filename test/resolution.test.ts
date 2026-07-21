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

describe('Java constructor/field DI wiring → references edges', () => {
  it('links a constructor-injected field to its collaborator class (Spring-style, same package)', async () => {
    const { graph } = await buildGraph({
      root: project({
        'src/com/a/UserPreferencesRepository.java': 'package com.a;\npublic class UserPreferencesRepository {}\n',
        'src/com/a/PreferencesController.java':
          'package com.a;\n\npublic class PreferencesController {\n' +
          '  private final UserPreferencesRepository repo;\n\n' +
          '  public PreferencesController(UserPreferencesRepository repo) {\n' +
          '    this.repo = repo;\n' +
          '  }\n' +
          '}\n',
      }),
      generatedAt: PIN,
      inline: true,
    });
    expect(hasEdge(graph, 'references', 'PreferencesController', 'UserPreferencesRepository')).toBe(true);
  });

  it('links a constructor-injected field across packages via an import (no `new`, no direct method call)', async () => {
    const { graph } = await buildGraph({
      root: project({
        'src/com/a/UserPreferencesRepository.java': 'package com.a;\npublic class UserPreferencesRepository {}\n',
        'src/com/b/PreferencesController.java':
          'package com.b;\n\nimport com.a.UserPreferencesRepository;\n\n' +
          'public class PreferencesController {\n' +
          '  private final UserPreferencesRepository repo;\n\n' +
          '  public PreferencesController(UserPreferencesRepository repo) {\n' +
          '    this.repo = repo;\n' +
          '  }\n' +
          '}\n',
      }),
      generatedAt: PIN,
      inline: true,
    });
    expect(hasEdge(graph, 'references', 'PreferencesController', 'UserPreferencesRepository')).toBe(true);
  });

  it('get_node-style callers reflect DI wiring even with zero direct calls', async () => {
    const { graph } = await buildGraph({
      root: project({
        'src/com/a/UserPreferencesRepository.java': 'package com.a;\npublic class UserPreferencesRepository {}\n',
        'src/com/a/PreferencesController.java':
          'package com.a;\n\npublic class PreferencesController {\n' +
          '  private final UserPreferencesRepository repo;\n\n' +
          '  public PreferencesController(UserPreferencesRepository repo) {\n' +
          '    this.repo = repo;\n' +
          '  }\n' +
          '}\n',
      }),
      generatedAt: PIN,
      inline: true,
    });
    const { indexFor } = await import('../src/engine/relations.js');
    const repo = graph.nodes.find((n) => n.kind === 'class' && n.name === 'UserPreferencesRepository')!;
    const callers = indexFor(graph).callers(repo.id);
    expect(callers.length).toBeGreaterThan(0);
  });
});

describe('Swift test-file cross-directory resolution', () => {
  it('resolves a test-file call into product code living in a sibling directory (Xcode Tests/ layout)', async () => {
    const { graph } = await buildGraph({
      root: project({
        'App/AppleSignInCoordinator.swift': 'class AppleSignInCoordinator {\n  init(submitter: Any, setError: Any) {}\n}\n',
        'AppTests/AppleSignInCoordinatorTests.swift':
          'import XCTest\n\n' +
          'class AppleSignInCoordinatorTests: XCTestCase {\n' +
          '  private func makeSUT() -> AppleSignInCoordinator {\n' +
          '    return AppleSignInCoordinator(submitter: 1, setError: 2)\n' +
          '  }\n' +
          '}\n',
      }),
      generatedAt: PIN,
      inline: true,
    });
    expect(hasEdge(graph, 'call', 'makeSUT', 'AppleSignInCoordinator')).toBe(true);
  });

  it('does NOT extend the fallback to non-test code (precision guard)', async () => {
    const { graph } = await buildGraph({
      root: project({
        // Two unrelated Swift files in different directories, neither a test —
        // the Swift test-file fallback must not fire here; without an import or
        // same-directory reachability this is honest non-resolution.
        'App/One/Widget.swift': 'class Widget {\n  init() {}\n}\n',
        'App/Two/Factory.swift': 'class Factory {\n  func make() -> Widget {\n    return Widget()\n  }\n}\n',
      }),
      generatedAt: PIN,
      inline: true,
    });
    expect(hasEdge(graph, 'call', 'make', 'Widget')).toBe(false);
  });
});

describe('qualified calls do not self-loop (heuristic)', () => {
  it('does NOT resolve `crud.foo()` inside `def foo` to the enclosing def itself (Python)', async () => {
    const { graph } = await buildGraph({
      root: project({
        // FastAPI-style delegation: the view function and the crud function
        // share a name; the qualified call must not become a self-edge.
        'app/views.py': 'from . import crud\n\ndef get_product(id):\n    return crud.get_product(id)\n',
        'app/crud.py': 'def get_product(id):\n    return id\n',
      }),
      generatedAt: PIN,
      inline: true,
    });
    const nameById = new Map(graph.nodes.map((n) => [n.id, n.name]));
    const selfLoops = graph.edges.filter(
      (e) => e.kind === 'call' && e.src === e.dst && nameById.get(e.src) === 'get_product',
    );
    expect(selfLoops).toHaveLength(0);
  });

  it('keeps bare recursion as an honest self-edge (Python)', async () => {
    const { graph } = await buildGraph({
      root: project({
        'fib.py': 'def fib(n):\n    if n < 2:\n        return n\n    return fib(n - 1) + fib(n - 2)\n',
      }),
      generatedAt: PIN,
      inline: true,
    });
    const nameById = new Map(graph.nodes.map((n) => [n.id, n.name]));
    const selfLoops = graph.edges.filter(
      (e) => e.kind === 'call' && e.src === e.dst && nameById.get(e.src) === 'fib',
    );
    expect(selfLoops).toHaveLength(1);
  });

  it('does NOT resolve `this.foo()`-style member calls to the enclosing same-named def (TypeScript heuristic floor)', async () => {
    const { graph } = await buildGraph({
      root: project({
        'svc.ts': 'const api = { run(): number { return 1; } };\nexport function run(): number {\n  return api.run();\n}\n',
      }),
      generatedAt: PIN,
      inline: true,
      noTsc: true,
    });
    const fn = graph.nodes.find((n) => n.kind === 'function' && n.name === 'run');
    const selfLoop = graph.edges.find((e) => e.kind === 'call' && e.src === fn?.id && e.dst === fn?.id);
    expect(selfLoop).toBeUndefined();
  });
});

/**
 * C# dependency-injection resolution. A controller/service depends on an
 * interface (constructor/field injection) and calls it, with the concrete
 * implementation in a different namespace + directory. Before, the interface
 * method and its implementation shared a name → every call through the interface
 * was ambiguous and dropped, so DI-wired services looked like orphans (0
 * callers, 0 tests, no impact). These pin the fix and its precision guards.
 */
describe('C# dependency-injection resolution', () => {
  // interface + implementation (+ injected repo) in one namespace/dir; the
  // caller and the test are in OTHER namespaces/dirs that `using`-import it.
  const diProject = () =>
    project({
      'src/Service/IRefreshTokenService.cs':
        'namespace Bridge.Service.Security\n{\n    public interface IRefreshTokenService { string Refresh(string t); }\n}\n',
      'src/Service/RefreshTokenService.cs':
        'namespace Bridge.Service.Security\n{\n    public interface IRefreshTokenRepository { string Rotate(string t); }\n' +
        '    public class RefreshTokenService : IRefreshTokenService\n    {\n' +
        '        private readonly IRefreshTokenRepository _repo;\n' +
        '        public RefreshTokenService(IRefreshTokenRepository repo) { _repo = repo; }\n' +
        '        public string Refresh(string t) { return _repo.Rotate(t); }\n    }\n}\n',
      'src/Controllers/AuthController.cs':
        'using Bridge.Service.Security;\nnamespace Bridge.WebAPI.Controllers\n{\n' +
        '    public class AuthController\n    {\n' +
        '        private readonly IRefreshTokenService _svc;\n' +
        '        public AuthController(IRefreshTokenService svc) { _svc = svc; }\n' +
        '        public string Refresh(string t) { return _svc.Refresh(t); }\n    }\n}\n',
      'tests/RefreshTokenServiceTests.cs':
        'using Bridge.Service.Security;\nnamespace Bridge.Service.UnitTests\n{\n' +
        '    public class RefreshTokenServiceTests\n    {\n' +
        '        public void Rotates() { var s = new RefreshTokenService(null); s.Refresh("a"); }\n    }\n}\n',
    });

  it('resolves an interface-injected call to the concrete implementation across namespaces', async () => {
    const { graph } = await buildGraph({ root: diProject(), generatedAt: PIN, inline: true });
    // The DI call AuthController.Refresh → RefreshTokenService.Refresh (impl),
    // disambiguated from the interface method via the `: IRefreshTokenService`
    // heritage — not dropped as ambiguous, not linked to the interface method.
    expect(hasEdge(graph, 'call', 'Refresh', 'Refresh')).toBe(true);
    const nameById = new Map(graph.nodes.map((n) => [n.id, n]));
    const callEdge = graph.edges.find(
      (e) => e.kind === 'call' && nameById.get(e.src)?.qualifiedName === 'AuthController.Refresh',
    );
    expect(callEdge).toBeDefined();
    expect(nameById.get(callEdge!.dst)?.qualifiedName).toBe('RefreshTokenService.Refresh');
    expect((graph.unknowns ?? []).length).toBe(0);
  });

  it('captures constructor/field injected interface types as references edges', async () => {
    const { graph } = await buildGraph({ root: diProject(), generatedAt: PIN, inline: true });
    expect(hasEdge(graph, 'references', 'AuthController', 'IRefreshTokenService')).toBe(true);
    expect(hasEdge(graph, 'references', 'RefreshTokenService', 'IRefreshTokenRepository')).toBe(true);
  });

  it('links a test that constructs the service (new Service) to the class', async () => {
    const { graph } = await buildGraph({ root: diProject(), generatedAt: PIN, inline: true });
    // `new RefreshTokenService(...)` from the test → the class, so tests_for/
    // coverage stop reporting the service as untested.
    expect(hasEdge(graph, 'call', 'Rotates', 'RefreshTokenService')).toBe(true);
  });

  it('still resolves the cross-namespace heritage edge (impl → interface)', async () => {
    const { graph } = await buildGraph({ root: diProject(), generatedAt: PIN, inline: true });
    expect(hasEdge(graph, 'extends', 'RefreshTokenService', 'IRefreshTokenService')).toBe(true);
  });

  it('does NOT resolve across namespaces WITHOUT a using/shared-namespace (precision)', async () => {
    // Same shapes, but the caller neither shares the namespace nor imports it —
    // so the target is genuinely out of scope and must stay unresolved.
    const { graph } = await buildGraph({
      root: project({
        'src/Service/IFoo.cs': 'namespace A.Services\n{\n    public interface IFoo { void Do(); }\n}\n',
        'src/Service/Foo.cs':
          'namespace A.Services\n{\n    public class Foo : IFoo { public void Do() {} }\n}\n',
        // No `using A.Services;`, different namespace → Do() is not in scope.
        'src/Other/Bar.cs':
          'namespace B.Other\n{\n    public class Bar { private IFoo _f; public void Run() { _f.Do(); } }\n}\n',
      }),
      generatedAt: PIN,
      inline: true,
    });
    expect(hasEdge(graph, 'call', 'Run', 'Do')).toBe(false);
  });

  it('TypeScript single-implementation bridge resolves an interface-injected call to the impl', async () => {
    const { graph } = await buildGraph({
      root: project({
        'src/svc/types.ts': 'export interface ISvc { run(t: string): string }\n',
        'src/svc/svc.ts':
          "import { ISvc } from './types';\nexport class Svc implements ISvc { run(t: string): string { return t; } }\n",
        'src/web/ctrl.ts':
          "import { ISvc } from '../svc/types';\nexport class Ctrl {\n  constructor(private svc: ISvc) {}\n  run(t: string): string { return this.svc.run(t); }\n}\n",
      }),
      generatedAt: PIN,
      inline: true,
    });
    const nameById = new Map(graph.nodes.map((n) => [n.id, n]));
    const call = graph.edges.find((e) => e.kind === 'call' && nameById.get(e.src)?.qualifiedName === 'Ctrl.run');
    expect(call && nameById.get(call.dst)?.qualifiedName).toBe('Svc.run');
  });

  it('TypeScript bridge does NOT fire when an interface has TWO implementations (precision)', async () => {
    const { graph } = await buildGraph({
      root: project({
        'src/svc/types.ts': 'export interface ISvc { run(t: string): string }\n',
        'src/svc/a.ts': "import { ISvc } from './types';\nexport class SvcA implements ISvc { run(t: string): string { return t; } }\n",
        'src/svc/b.ts': "import { ISvc } from './types';\nexport class SvcB implements ISvc { run(t: string): string { return t; } }\n",
        'src/web/ctrl.ts':
          "import { ISvc } from '../svc/types';\nexport class Ctrl {\n  constructor(private svc: ISvc) {}\n  run(t: string): string { return this.svc.run(t); }\n}\n",
      }),
      generatedAt: PIN,
      inline: true,
    });
    const nameById = new Map(graph.nodes.map((n) => [n.id, n.qualifiedName]));
    // Two impls → ambiguous → no bridged call to either SvcA.run or SvcB.run.
    const bridged = graph.edges.some(
      (e) => e.kind === 'call' && nameById.get(e.src) === 'Ctrl.run' && /^Svc[AB]\.run$/.test(nameById.get(e.dst) ?? ''),
    );
    expect(bridged).toBe(false);
  });

  it('does NOT invent an interface/impl edge when there is no heritage declaration (precision)', async () => {
    // Two unrelated classes each define `Save`; a caller importing the namespace
    // sees both, they are NOT an interface/impl family, so the call stays
    // ambiguous and unresolved rather than picking one.
    const { graph } = await buildGraph({
      root: project({
        'src/S/A.cs': 'namespace S\n{\n    public class A { public void Save() {} }\n}\n',
        'src/S/B.cs': 'namespace S\n{\n    public class B { public void Save() {} }\n}\n',
        'src/C/Caller.cs':
          'using S;\nnamespace C\n{\n    public class Caller { private A _a; public void Go() { _a.Save(); } }\n}\n',
      }),
      generatedAt: PIN,
      inline: true,
    });
    expect(hasEdge(graph, 'call', 'Go', 'Save')).toBe(false);
  });
});
