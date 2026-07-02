import { describe, it, expect, afterEach } from 'vitest';
import { buildGraph } from '../src/engine/build.js';
import { makeProject, cleanup } from './helpers.js';
import type { VgGraph } from '../src/schema.js';

/**
 * Phase-3 language expansion: PHP, Kotlin, Swift, Scala, Dart, Lua, Elixir,
 * Shell, Zig, C, C++. Each case builds a mini-project and asserts definitions
 * are extracted and (where the language's visibility rules allow) a cross-file
 * call edge resolves. Query specs were validated capture-by-capture against the
 * bundled grammars before landing here.
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

async function graphOf(files: Record<string, string>): Promise<VgGraph> {
  const { graph } = await buildGraph({ root: project(files), generatedAt: PIN, inline: true });
  return graph;
}

const defNames = (g: VgGraph) => g.nodes.filter((n) => n.kind !== 'file' && n.kind !== 'external').map((n) => n.name);
function hasCallEdge(g: VgGraph, src: string, dst: string): boolean {
  const nameById = new Map(g.nodes.map((n) => [n.id, n.name]));
  return g.edges.some((e) => e.kind === 'call' && nameById.get(e.src) === src && nameById.get(e.dst) === dst);
}

describe('new language extraction', () => {
  it('PHP: functions, methods, classes; use + require imports; member calls', async () => {
    const g = await graphOf({
      'src/Service.php': `<?php\nnamespace App;\nrequire_once 'helpers.php';\nclass Service extends Base {\n    public function run(int $id) {\n        return validate($id);\n    }\n}\n`,
      'src/helpers.php': `<?php\nfunction validate($v) { return $v; }\n`,
    });
    expect(defNames(g)).toEqual(expect.arrayContaining(['Service', 'run', 'validate']));
    expect(hasCallEdge(g, 'run', 'validate')).toBe(true);
  });

  it('Kotlin: same-package visibility resolves cross-file bare calls', async () => {
    const g = await graphOf({
      'app/UserService.kt': `package com.app\n\nclass UserService {\n    fun findUser(id: Int): Int {\n        return validate(id)\n    }\n}\n`,
      'app/Validators.kt': `package com.app\n\nfun validate(v: Int): Int = v\n`,
    });
    expect(defNames(g)).toEqual(expect.arrayContaining(['UserService', 'findUser', 'validate']));
    expect(hasCallEdge(g, 'findUser', 'validate')).toBe(true);
  });

  it('Swift: classes, protocols, functions; module-wide visibility', async () => {
    const g = await graphOf({
      'Sources/Service.swift': `class Service {\n    func run(id: Int) -> Int {\n        return validate(id)\n    }\n}\n`,
      'Sources/Validate.swift': `func validate(_ v: Int) -> Int { return v }\nprotocol Marker {}\n`,
    });
    expect(defNames(g)).toEqual(expect.arrayContaining(['Service', 'run', 'validate', 'Marker']));
    expect(hasCallEdge(g, 'run', 'validate')).toBe(true);
  });

  it('Scala: defs, traits, objects; same-package resolution; extends', async () => {
    const g = await graphOf({
      'src/Service.scala': `package app\n\nclass Service extends Base {\n  def run(id: Int): Int = {\n    validate(id)\n  }\n}\n`,
      'src/Util.scala': `package app\n\nclass Base {}\ntrait Marker {}\nobject Util {\n  def validate(v: Int): Int = v\n}\n`,
    });
    expect(defNames(g)).toEqual(expect.arrayContaining(['Service', 'run', 'Base', 'Util', 'validate']));
    const nameById = new Map(g.nodes.map((n) => [n.id, n.name]));
    expect(g.edges.some((e) => e.kind === 'extends' && nameById.get(e.src) === 'Service' && nameById.get(e.dst) === 'Base')).toBe(true);
  });

  it('Dart: signature-based defs and sibling-selector calls', async () => {
    const g = await graphOf({
      'lib/service.dart': `import 'util.dart';\n\nclass Service {\n  int run(int id) {\n    return validate(id);\n  }\n}\n`,
      'lib/util.dart': `int validate(int v) {\n  return v;\n}\n`,
    });
    expect(defNames(g)).toEqual(expect.arrayContaining(['Service', 'run', 'validate']));
    expect(hasCallEdge(g, 'run', 'validate')).toBe(true);
  });

  it('Lua: function defs (plain/field/method/local) and require imports', async () => {
    const g = await graphOf({
      'src/service.lua': `local util = require("src.util")\n\nlocal M = {}\n\nfunction M.run(id)\n  return validate(id)\nend\n\nfunction M:describe()\n  return "svc"\nend\n\nlocal function validate(v)\n  return v\nend\n\nreturn M\n`,
    });
    expect(defNames(g)).toEqual(expect.arrayContaining(['run', 'describe', 'validate']));
    expect(hasCallEdge(g, 'run', 'validate')).toBe(true);
  });

  it('Elixir: defmodule/def/defp extraction; no def-head self-loop edges', async () => {
    const g = await graphOf({
      'lib/accounts.ex': `defmodule Accounts do\n  alias App.Repo\n\n  def get_user(id) do\n    validate(id)\n  end\n\n  defp validate(id) do\n    id\n  end\nend\n`,
    });
    expect(defNames(g)).toEqual(expect.arrayContaining(['Accounts', 'get_user', 'validate']));
    expect(hasCallEdge(g, 'get_user', 'validate')).toBe(true);
    // The def-head is itself a `call` node in this grammar — it must not create
    // a self-loop edge for the non-recursive get_user.
    const selfLoops = g.edges.filter((e) => e.kind === 'call' && e.src === e.dst);
    expect(selfLoops).toHaveLength(0);
  });

  it('Shell: function defs; sourced-file calls resolve; external commands do not', async () => {
    const g = await graphOf({
      'scripts/deploy.sh': `#!/usr/bin/env sh\nsource ./lib.sh\n\nmain() {\n  prepare\n  rsync -a src dst\n}\nmain\n`,
      'scripts/lib.sh': `prepare() {\n  echo ready\n}\n`,
    });
    expect(defNames(g)).toEqual(expect.arrayContaining(['main', 'prepare']));
    expect(hasCallEdge(g, 'main', 'prepare')).toBe(true);
    // `rsync` is an external binary — must not appear as a def or an edge target.
    expect(defNames(g)).not.toContain('rsync');
  });

  it('Zig: fn/struct defs and @import resolution', async () => {
    const g = await graphOf({
      'src/main.zig': `const util = @import("util.zig");\n\npub fn run(id: u32) u32 {\n    return util.validate(id);\n}\n`,
      'src/util.zig': `pub fn validate(v: u32) u32 {\n    return v;\n}\n`,
    });
    expect(defNames(g)).toEqual(expect.arrayContaining(['run', 'validate']));
    expect(hasCallEdge(g, 'run', 'validate')).toBe(true);
  });

  it('C: function definitions (not prototypes) and #include resolution', async () => {
    const g = await graphOf({
      'src/main.c': `#include "util.h"\n\nint run(int id) {\n    return validate(id);\n}\n`,
      'src/util.h': `int validate(int v);\n`,
      'src/util.c': `#include "util.h"\n\nint validate(int v) {\n    return v;\n}\n`,
    });
    const names = defNames(g);
    expect(names).toEqual(expect.arrayContaining(['run', 'validate']));
    // The prototype in util.h must not create a second `validate` def.
    expect(names.filter((n) => n === 'validate')).toHaveLength(1);
  });

  it('C++: classes, out-of-line methods, namespaces, base classes', async () => {
    const g = await graphOf({
      'src/shape.hpp': `#pragma once\nnamespace app {\nclass Base { public: int id; };\nclass Shape : public Base {\n  public:\n    int area();\n};\n}\n`,
      'src/shape.cpp': `#include "shape.hpp"\nnamespace app {\nint Shape::area() {\n    return helper();\n}\nint helper() {\n    return 1;\n}\n}\n`,
    });
    expect(defNames(g)).toEqual(expect.arrayContaining(['Shape', 'Base', 'area', 'helper', 'app']));
    expect(hasCallEdge(g, 'area', 'helper')).toBe(true);
    const nameById = new Map(g.nodes.map((n) => [n.id, n.name]));
    expect(g.edges.some((e) => e.kind === 'extends' && nameById.get(e.src) === 'Shape' && nameById.get(e.dst) === 'Base')).toBe(true);
  });

  it('qualified calls in new languages do not fabricate self-loops', async () => {
    // The delegation trap that produced 100% false self-loops in Python: a
    // same-named function delegating via a qualified call.
    const g = await graphOf({
      'src/a.kt': `package app\n\nfun process(v: Int): Int = util.process(v)\n`,
      'src/b.php': `<?php\nfunction handle($v) { return $this->other->handle($v); }\n`,
    });
    const selfLoops = g.edges.filter((e) => e.kind === 'call' && e.src === e.dst);
    expect(selfLoops).toHaveLength(0);
  });
});
