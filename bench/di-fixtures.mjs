/**
 * Cross-language dependency-injection (interface → implementation) resolution
 * fixtures. Each entry is a deterministic, idiomatic mini-repo exercising the
 * DI shape every large codebase uses: a controller/consumer depends on an
 * INTERFACE (constructor/field injection), calls it, and the concrete
 * implementation lives in a DIFFERENT module/namespace/package — plus a test
 * that constructs the concrete type.
 *
 * The heuristic resolver does not track a receiver's declared type, so
 * interface-mediated dispatch is the hardest edge to resolve without a compiler.
 * This corpus measures, per language, how many of the four DI signals the graph
 * recovers, so `bench:di` can track it release-over-release and the CI gate can
 * lock in the languages that work (and guard against regressions).
 *
 * Four DI signals scored per language (each an edge the graph should contain):
 *   - injectedCall  — the interface-typed call resolves to the implementation
 *                     (or the interface method): consumer.method → *.<method>
 *   - testLink      — the test links to the concrete service (construct or call)
 *   - references    — the injected interface is captured as a dependency edge
 *   - implementsEdge— the impl→interface conformance (extends/implements)
 *
 * `note` records a known structural limitation (e.g. Go's implicit interfaces,
 * Obj-C message-sends) so the report explains a low score rather than hiding it.
 */

/** Signal check: does the graph contain an edge of `kind` whose src/dst
 *  qualifiedNames contain the given fragments? `kinds` may list alternatives. */
function edge(kinds, srcHas, dstHas) {
  return { kinds: Array.isArray(kinds) ? kinds : [kinds], srcHas, dstHas };
}

export const DI_LANGS = [
  {
    lang: 'cs',
    label: 'C#',
    files: {
      'src/Service/IRefreshTokenService.cs':
        'namespace Svc\n{\n    public interface IRefreshTokenService { string Refresh(string t); }\n}\n',
      'src/Service/RefreshTokenService.cs':
        'namespace Svc\n{\n    public interface IRefreshTokenRepository { string Rotate(string t); }\n' +
        '    public class RefreshTokenService : IRefreshTokenService\n    {\n' +
        '        private readonly IRefreshTokenRepository _repo;\n' +
        '        public RefreshTokenService(IRefreshTokenRepository repo) { _repo = repo; }\n' +
        '        public string Refresh(string t) { return _repo.Rotate(t); }\n    }\n}\n',
      'src/Web/AuthController.cs':
        'using Svc;\nnamespace Web\n{\n    public class AuthController\n    {\n' +
        '        private readonly IRefreshTokenService _svc;\n' +
        '        public AuthController(IRefreshTokenService svc) { _svc = svc; }\n' +
        '        public string Refresh(string t) { return _svc.Refresh(t); }\n    }\n}\n',
      'tests/RefreshTokenServiceTests.cs':
        'using Svc;\nnamespace Tests\n{\n    public class RefreshTokenServiceTests\n    {\n' +
        '        public void Rotates() { var s = new RefreshTokenService(null); s.Refresh("a"); }\n    }\n}\n',
    },
    expect: {
      injectedCall: edge('call', 'AuthController.Refresh', 'RefreshTokenService.Refresh'),
      testLink: edge('call', 'Rotates', 'RefreshTokenService'),
      references: edge('references', 'AuthController', 'IRefreshTokenService'),
      implementsEdge: edge(['extends', 'implements'], 'RefreshTokenService', 'IRefreshTokenService'),
    },
  },
  {
    lang: 'java',
    label: 'Java',
    files: {
      'src/svc/IRefreshTokenService.java':
        'package svc;\npublic interface IRefreshTokenService { String refresh(String t); }\n',
      'src/svc/IRefreshTokenRepository.java':
        'package svc;\npublic interface IRefreshTokenRepository { String rotate(String t); }\n',
      'src/svc/RefreshTokenService.java':
        'package svc;\npublic class RefreshTokenService implements IRefreshTokenService {\n' +
        '    private final IRefreshTokenRepository repo;\n' +
        '    public RefreshTokenService(IRefreshTokenRepository repo) { this.repo = repo; }\n' +
        '    public String refresh(String t) { return repo.rotate(t); }\n}\n',
      'src/web/AuthController.java':
        'package web;\nimport svc.IRefreshTokenService;\npublic class AuthController {\n' +
        '    private final IRefreshTokenService svc;\n' +
        '    public AuthController(IRefreshTokenService svc) { this.svc = svc; }\n' +
        '    public String refresh(String t) { return svc.refresh(t); }\n}\n',
      'tests/RefreshTokenServiceTest.java':
        'package tests;\nimport svc.RefreshTokenService;\npublic class RefreshTokenServiceTest {\n' +
        '    public void rotates() { RefreshTokenService s = new RefreshTokenService(null); s.refresh("a"); }\n}\n',
    },
    expect: {
      injectedCall: edge('call', 'AuthController.refresh', 'RefreshTokenService.refresh'),
      testLink: edge('call', 'rotates', 'RefreshTokenService'),
      references: edge('references', 'AuthController', 'IRefreshTokenService'),
      implementsEdge: edge(['implements', 'extends'], 'RefreshTokenService', 'IRefreshTokenService'),
    },
  },
  {
    lang: 'kotlin',
    label: 'Kotlin',
    files: {
      'src/svc/IRefreshTokenService.kt':
        'package svc\ninterface IRefreshTokenService { fun refresh(t: String): String }\n',
      'src/svc/IRefreshTokenRepository.kt':
        'package svc\ninterface IRefreshTokenRepository { fun rotate(t: String): String }\n',
      'src/svc/RefreshTokenService.kt':
        'package svc\nclass RefreshTokenService(private val repo: IRefreshTokenRepository) : IRefreshTokenService {\n' +
        '    override fun refresh(t: String): String { return repo.rotate(t) }\n}\n',
      'src/web/AuthController.kt':
        'package web\nimport svc.IRefreshTokenService\nclass AuthController(private val svc: IRefreshTokenService) {\n' +
        '    fun refresh(t: String): String { return svc.refresh(t) }\n}\n',
      'tests/RefreshTokenServiceTest.kt':
        'package tests\nimport svc.RefreshTokenService\nclass RefreshTokenServiceTest {\n' +
        '    fun rotates() { val s = RefreshTokenService(FakeRepo()); s.refresh("a") }\n}\n',
    },
    expect: {
      injectedCall: edge('call', 'AuthController.refresh', 'RefreshTokenService.refresh'),
      testLink: edge('call', 'rotates', 'RefreshTokenService'),
      references: edge('references', 'AuthController', 'IRefreshTokenService'),
      implementsEdge: edge(['implements', 'extends'], 'RefreshTokenService', 'IRefreshTokenService'),
    },
  },
  {
    lang: 'scala',
    label: 'Scala',
    files: {
      'src/svc/IRefreshTokenService.scala':
        'package svc\ntrait IRefreshTokenService { def refresh(t: String): String }\n',
      'src/svc/IRefreshTokenRepository.scala':
        'package svc\ntrait IRefreshTokenRepository { def rotate(t: String): String }\n',
      'src/svc/RefreshTokenService.scala':
        'package svc\nclass RefreshTokenService(repo: IRefreshTokenRepository) extends IRefreshTokenService {\n' +
        '    def refresh(t: String): String = repo.rotate(t)\n}\n',
      'src/web/AuthController.scala':
        'package web\nimport svc.IRefreshTokenService\nclass AuthController(svc: IRefreshTokenService) {\n' +
        '    def refresh(t: String): String = svc.refresh(t)\n}\n',
      'tests/RefreshTokenServiceTest.scala':
        'package tests\nimport svc.RefreshTokenService\nclass RefreshTokenServiceTest {\n' +
        '    def rotates(): Unit = { val s = new RefreshTokenService(null); s.refresh("a") }\n}\n',
    },
    expect: {
      injectedCall: edge('call', 'AuthController.refresh', 'RefreshTokenService.refresh'),
      testLink: edge('call', 'rotates', 'RefreshTokenService'),
      references: edge('references', 'AuthController', 'IRefreshTokenService'),
      implementsEdge: edge(['extends', 'implements'], 'RefreshTokenService', 'IRefreshTokenService'),
    },
  },
  {
    lang: 'dart',
    label: 'Dart',
    files: {
      'lib/svc/service.dart':
        "abstract class IRefreshTokenService { String refresh(String t); }\n" +
        "abstract class IRefreshTokenRepository { String rotate(String t); }\n" +
        "class RefreshTokenService implements IRefreshTokenService {\n" +
        "  final IRefreshTokenRepository repo;\n  RefreshTokenService(this.repo);\n" +
        "  String refresh(String t) { return repo.rotate(t); }\n}\n",
      'lib/web/controller.dart':
        "import '../svc/service.dart';\nclass AuthController {\n" +
        "  final IRefreshTokenService svc;\n  AuthController(this.svc);\n" +
        "  String refresh(String t) { return svc.refresh(t); }\n}\n",
      'test/service_test.dart':
        "import '../lib/svc/service.dart';\nvoid rotates() { var s = RefreshTokenService(null); s.refresh('a'); }\n",
    },
    expect: {
      injectedCall: edge('call', 'AuthController.refresh', 'RefreshTokenService.refresh'),
      testLink: edge('call', 'rotates', 'RefreshTokenService'),
      references: edge('references', 'AuthController', 'IRefreshTokenService'),
      implementsEdge: edge(['implements', 'extends'], 'RefreshTokenService', 'IRefreshTokenService'),
    },
  },
  {
    lang: 'php',
    label: 'PHP',
    files: {
      'src/Service/IRefreshTokenService.php':
        "<?php\nnamespace App\\Service;\ninterface IRefreshTokenService { public function refresh(string $t): string; }\n",
      'src/Service/IRefreshTokenRepository.php':
        "<?php\nnamespace App\\Service;\ninterface IRefreshTokenRepository { public function rotate(string $t): string; }\n",
      'src/Service/RefreshTokenService.php':
        "<?php\nnamespace App\\Service;\nclass RefreshTokenService implements IRefreshTokenService {\n" +
        "    private IRefreshTokenRepository $repo;\n" +
        "    public function __construct(IRefreshTokenRepository $repo) { $this->repo = $repo; }\n" +
        "    public function refresh(string $t): string { return $this->repo->rotate($t); }\n}\n",
      'src/Web/AuthController.php':
        "<?php\nnamespace App\\Web;\nuse App\\Service\\IRefreshTokenService;\nclass AuthController {\n" +
        "    private IRefreshTokenService $svc;\n" +
        "    public function __construct(IRefreshTokenService $svc) { $this->svc = $svc; }\n" +
        "    public function refresh(string $t): string { return $this->svc->refresh($t); }\n}\n",
      'tests/RefreshTokenServiceTest.php':
        "<?php\nnamespace App\\Tests;\nuse App\\Service\\RefreshTokenService;\nclass RefreshTokenServiceTest {\n" +
        "    public function rotates(): void { $s = new RefreshTokenService(null); $s->refresh('a'); }\n}\n",
    },
    expect: {
      injectedCall: edge('call', 'AuthController.refresh', 'RefreshTokenService.refresh'),
      testLink: edge('call', 'rotates', 'RefreshTokenService'),
      references: edge('references', 'AuthController', 'IRefreshTokenService'),
      implementsEdge: edge(['implements', 'extends'], 'RefreshTokenService', 'IRefreshTokenService'),
    },
  },
  {
    lang: 'ts',
    label: 'TypeScript',
    files: {
      'src/svc/types.ts': 'export interface IRefreshTokenService { refresh(t: string): string }\n',
      'src/svc/repo.ts': 'export interface IRefreshTokenRepository { rotate(t: string): string }\n',
      'src/svc/service.ts':
        "import { IRefreshTokenService } from './types';\nimport { IRefreshTokenRepository } from './repo';\n" +
        'export class RefreshTokenService implements IRefreshTokenService {\n' +
        '  constructor(private repo: IRefreshTokenRepository) {}\n' +
        '  refresh(t: string): string { return this.repo.rotate(t); }\n}\n',
      'src/web/controller.ts':
        "import { IRefreshTokenService } from '../svc/types';\nexport class AuthController {\n" +
        '  constructor(private svc: IRefreshTokenService) {}\n' +
        '  refresh(t: string): string { return this.svc.refresh(t); }\n}\n',
      'src/svc/service.spec.ts':
        "import { RefreshTokenService } from './service';\nfunction rotates() { const s = new RefreshTokenService(null as any); s.refresh('a'); }\n",
    },
    expect: {
      injectedCall: edge('call', 'AuthController.refresh', 'RefreshTokenService.refresh'),
      testLink: edge('call', 'rotates', 'RefreshTokenService'),
      references: edge('references', 'AuthController', 'IRefreshTokenService'),
      implementsEdge: edge(['implements', 'extends'], 'RefreshTokenService', 'IRefreshTokenService'),
    },
  },
  {
    lang: 'go',
    label: 'Go',
    note: 'Go interface conformance is implicit (no `implements` keyword), so interface↔impl cannot be linked without type inference.',
    files: {
      'go.mod': 'module example.com/di\n\ngo 1.21\n',
      'svc/service.go':
        'package svc\n\ntype IRefreshTokenService interface { Refresh(t string) string }\n' +
        'type IRefreshTokenRepository interface { Rotate(t string) string }\n' +
        'type RefreshTokenService struct { repo IRefreshTokenRepository }\n' +
        'func (s *RefreshTokenService) Refresh(t string) string { return s.repo.Rotate(t) }\n',
      'web/controller.go':
        'package web\n\nimport "example.com/di/svc"\n\n' +
        'type AuthController struct { svc svc.IRefreshTokenService }\n' +
        'func (c *AuthController) Refresh(t string) string { return c.svc.Refresh(t) }\n',
      'svc/service_test.go':
        'package svc\n\nfunc rotates() { s := &RefreshTokenService{}; s.Refresh("a") }\n',
    },
    expect: {
      injectedCall: edge('call', 'AuthController.Refresh', 'RefreshTokenService.Refresh'),
      testLink: edge('call', 'rotates', 'RefreshTokenService.Refresh'),
      references: edge('references', 'AuthController', 'IRefreshTokenService'),
      implementsEdge: edge(['implements', 'extends'], 'RefreshTokenService', 'IRefreshTokenService'),
    },
  },
  {
    lang: 'rust',
    label: 'Rust',
    note: 'Trait conformance (`impl Trait for T`) and method calls need capture the heuristic floor lacks today.',
    files: {
      'src/svc.rs':
        'pub trait IRefreshTokenService { fn refresh(&self, t: &str) -> String; }\n' +
        'pub trait IRefreshTokenRepository { fn rotate(&self, t: &str) -> String; }\n' +
        'pub struct RefreshTokenService { pub repo: Box<dyn IRefreshTokenRepository> }\n' +
        'impl IRefreshTokenService for RefreshTokenService {\n' +
        '    fn refresh(&self, t: &str) -> String { self.repo.rotate(t) }\n}\n',
      'src/web.rs':
        'use crate::svc::IRefreshTokenService;\n' +
        'pub struct AuthController { pub svc: Box<dyn IRefreshTokenService> }\n' +
        'impl AuthController {\n    pub fn refresh(&self, t: &str) -> String { self.svc.refresh(t) }\n}\n',
    },
    expect: {
      injectedCall: edge('call', 'AuthController.refresh', 'RefreshTokenService.refresh'),
      testLink: null, // no idiomatic single-file test target here
      references: edge('references', 'AuthController', 'IRefreshTokenService'),
      implementsEdge: edge(['implements', 'extends'], 'RefreshTokenService', 'IRefreshTokenService'),
    },
  },
  {
    lang: 'swift',
    label: 'Swift',
    note: 'Swift has whole-module visibility (no imports); cross-file product→product dispatch is not modeled by the directory rung.',
    files: {
      'Sources/Svc/RefreshTokenServicing.swift':
        'protocol RefreshTokenServicing { func refresh(_ t: String) -> String }\n' +
        'protocol RefreshTokenRepositing { func rotate(_ t: String) -> String }\n',
      'Sources/Svc/RefreshTokenService.swift':
        'class RefreshTokenService: RefreshTokenServicing {\n  let repo: RefreshTokenRepositing\n' +
        '  init(_ repo: RefreshTokenRepositing) { self.repo = repo }\n' +
        '  func refresh(_ t: String) -> String { return repo.rotate(t) }\n}\n',
      'Sources/Web/AuthController.swift':
        'class AuthController {\n  let svc: RefreshTokenServicing\n  init(_ svc: RefreshTokenServicing) { self.svc = svc }\n' +
        '  func refresh(_ t: String) -> String { return svc.refresh(t) }\n}\n',
      'Tests/RefreshTokenServiceTests.swift':
        'func rotates() { let s = RefreshTokenService(FakeRepo()); _ = s.refresh("a") }\n',
    },
    expect: {
      injectedCall: edge('call', 'AuthController.refresh', 'RefreshTokenService.refresh'),
      testLink: edge(['call', 'test'], 'rotates', 'RefreshTokenService'),
      references: edge('references', 'AuthController', 'RefreshTokenServicing'),
      implementsEdge: edge(['extends', 'implements'], 'RefreshTokenService', 'RefreshTokenServicing'),
    },
  },
  {
    lang: 'objc',
    label: 'Objective-C',
    note: 'Bracket message-sends `[obj msg]` and @protocol blocks are not yet captured, so no DI edge can form.',
    files: {
      'Service/RefreshTokenService.h':
        '@protocol RefreshTokenServicing <NSObject>\n- (NSString *)refresh:(NSString *)t;\n@end\n' +
        '@interface RefreshTokenService : NSObject <RefreshTokenServicing>\n- (NSString *)refresh:(NSString *)t;\n@end\n',
      'Service/RefreshTokenService.m':
        '#import "RefreshTokenService.h"\n@implementation RefreshTokenService\n' +
        '- (NSString *)refresh:(NSString *)t { return t; }\n@end\n',
      'Web/AuthController.m':
        '#import "../Service/RefreshTokenService.h"\n@interface AuthController : NSObject\n@end\n' +
        '@implementation AuthController {\n  id<RefreshTokenServicing> _svc;\n}\n' +
        '- (NSString *)refresh:(NSString *)t { return [_svc refresh:t]; }\n@end\n',
    },
    expect: {
      injectedCall: edge('call', 'AuthController.refresh', 'RefreshTokenService.refresh'),
      testLink: null,
      references: edge('references', 'AuthController', 'RefreshTokenServicing'),
      implementsEdge: edge(['extends', 'implements'], 'RefreshTokenService', 'RefreshTokenServicing'),
    },
  },
];

/** The DI signals in scored order. `null` expectations are skipped (n/a). */
export const DI_SIGNALS = ['injectedCall', 'testLink', 'references', 'implementsEdge'];

/**
 * Exact dotted-segment subsequence match: `has("RefreshTokenService.refresh")`
 * matches a qualifiedName whose dotted segments contain `RefreshTokenService`
 * then `refresh` consecutively and EXACTLY — so it does NOT match the interface
 * method `IRefreshTokenService.refresh` (segment `IRefreshTokenService` ≠
 * `RefreshTokenService`). This is what makes the injectedCall signal measure
 * resolution to the CONCRETE implementation (the target that makes impact_of /
 * tests_for / find_path on the service work), not merely to the interface.
 */
function segMatch(qualifiedName, expected) {
  const segs = String(qualifiedName).split(/[.]/);
  const want = expected.split('.');
  for (let i = 0; i + want.length <= segs.length; i++) {
    if (want.every((w, j) => segs[i + j] === w)) return true;
  }
  return false;
}

/** Does `graph` contain the edge the signal describes? */
export function hasSignal(graph, spec) {
  if (!spec) return null; // n/a for this language
  const byId = new Map(graph.nodes.map((n) => [n.id, n.qualifiedName ?? n.name ?? '']));
  return graph.edges.some(
    (e) =>
      spec.kinds.includes(e.kind) &&
      segMatch(byId.get(e.src) ?? '', spec.srcHas) &&
      segMatch(byId.get(e.dst) ?? '', spec.dstHas),
  );
}

/** Score one language's graph: { resolved, applicable, signals: {name: bool|null} }. */
export function scoreDi(langEntry, graph) {
  const signals = {};
  let resolved = 0;
  let applicable = 0;
  for (const name of DI_SIGNALS) {
    const got = hasSignal(graph, langEntry.expect[name]);
    signals[name] = got;
    if (got === null) continue;
    applicable++;
    if (got) resolved++;
  }
  return { resolved, applicable, signals };
}
