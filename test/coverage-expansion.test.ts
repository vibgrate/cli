import { describe, it, expect } from 'vitest';
import { parseSource } from '../src/engine/parse.js';
import { langForExtension } from '../src/engine/languages.js';
import { extractEmbeddedScript } from '../src/engine/sfc.js';
import { relativeResolver } from '../src/engine/module-resolver.js';

/**
 * Coverage-expansion wave: Objective-C, OCaml, ReScript, Solidity (grammar-
 * backed), plus the container formats HTML (inline scripts), ERB (Ruby) and
 * EJS (JS). Query specs were validated capture-by-capture against the bundled
 * grammars before landing here — same bar as new-languages.test.ts.
 */

describe('registry covers the expansion extensions', () => {
  it.each([
    ['.m', 'objc'],
    ['.mm', 'objc'],
    ['.ml', 'ocaml'],
    ['.mli', 'ocaml'],
    ['.res', 'rescript'],
    ['.sol', 'solidity'],
    ['.html', 'html'],
    ['.htm', 'html'],
    ['.erb', 'erb'],
    ['.ejs', 'ejs'],
  ])('%s → %s', (ext, id) => {
    expect(langForExtension(ext)?.id).toBe(id);
  });
});

describe('Objective-C', () => {
  it('extracts classes, methods, functions, message sends, and #imports', async () => {
    const src = [
      '#import "Helper.h"',
      '@interface Service : NSObject',
      '@end',
      '@implementation Service',
      '- (int)run:(int)n {',
      '  [self helper];',
      '  return validate(n);',
      '}',
      '@end',
      'int validate(int v) { return v; }',
    ].join('\n');
    const p = await parseSource('Service.m', 'objc', src);
    const names = p.defs.map((d) => d.name);
    expect(names).toEqual(expect.arrayContaining(['Service', 'run', 'validate']));
    const callees = p.calls.map((c) => c.callee);
    expect(callees).toContain('validate');
    expect(callees).toContain('helper');
    // [self helper] is same-class evidence — must not be marked qualified.
    expect(p.calls.find((c) => c.callee === 'helper')!.qualified).toBe(false);
    expect(p.imports.map((i) => i.source)).toContain('Helper.h');
    expect(p.heritage).toEqual(
      expect.arrayContaining([expect.objectContaining({ superName: 'NSObject', kind: 'extends' })]),
    );
  });
});

describe('OCaml', () => {
  it('extracts functions, modules, applications, and opens', async () => {
    const src = [
      'open Printf',
      'let helper x = x + 1',
      'let run id = helper id',
      'module M = struct',
      '  let inner y = Str.global y',
      'end',
    ].join('\n');
    const p = await parseSource('main.ml', 'ocaml', src);
    expect(p.defs.map((d) => d.name)).toEqual(expect.arrayContaining(['helper', 'run', 'M', 'inner']));
    const helper = p.calls.find((c) => c.callee === 'helper');
    expect(helper).toBeDefined();
    expect(helper!.qualified).toBe(false); // bare application
    const qualified = p.calls.find((c) => c.callee === 'global');
    expect(qualified?.qualified).toBe(true); // Str.global — module-qualified
    expect(p.imports.map((i) => i.source)).toContain('Printf');
  });
});

describe('ReScript', () => {
  it('extracts let-bound functions, modules, calls, and opens', async () => {
    const src = [
      'open Belt',
      'let helper = x => x + 1',
      'let run = id => helper(id)',
      'let far = () => Utils.pull(1)',
      'module M = {',
      '  let inner = y => y',
      '}',
    ].join('\n');
    const p = await parseSource('main.res', 'rescript', src);
    expect(p.defs.map((d) => d.name)).toEqual(expect.arrayContaining(['helper', 'run', 'far', 'M', 'inner']));
    expect(p.calls.find((c) => c.callee === 'helper')!.qualified).toBe(false);
    expect(p.calls.find((c) => c.callee === 'pull')!.qualified).toBe(true);
    expect(p.imports.map((i) => i.source)).toContain('Belt');
  });
});

describe('Solidity', () => {
  it('extracts contracts, interfaces, functions, modifiers, calls, and inheritance', async () => {
    const src = [
      'pragma solidity ^0.8.0;',
      'import "./Base.sol";',
      'interface IToken { function total() external; }',
      'contract Token is Base {',
      '  modifier onlyOwner() { _; }',
      '  function transfer(uint a) public returns (uint) {',
      '    emit Done();',
      '    return validate(a);',
      '  }',
      '}',
      'function validate(uint v) pure returns (uint) { return v; }',
    ].join('\n');
    const p = await parseSource('Token.sol', 'solidity', src);
    expect(p.defs.map((d) => d.name)).toEqual(
      expect.arrayContaining(['IToken', 'Token', 'transfer', 'onlyOwner', 'validate', 'total']),
    );
    const callees = p.calls.map((c) => c.callee);
    expect(callees).toContain('validate');
    expect(callees).toContain('Done'); // emit
    expect(p.imports.map((i) => i.source)).toContain('./Base.sol');
    expect(p.heritage).toEqual(
      expect.arrayContaining([expect.objectContaining({ superName: 'Base', kind: 'extends' })]),
    );
  });
});

describe('HTML inline scripts', () => {
  it('parses inline <script> blocks and ignores markup', async () => {
    const src = [
      '<!doctype html>',
      '<body>',
      '<script>',
      "import { boot } from './app.js';",
      'function init() { boot(); }',
      '</script>',
      '</body>',
    ].join('\n');
    const p = await parseSource('index.html', 'html', src);
    expect(p.lang).toBe('html');
    expect(p.defs.map((d) => d.name)).toContain('init');
    expect(p.defs.find((d) => d.name === 'init')!.startLine).toBe(5);
    expect(p.calls.map((c) => c.callee)).toContain('boot');
    expect(p.imports.map((i) => i.source)).toContain('./app.js');
  });
});

describe('ERB / EJS templates', () => {
  it('parses ERB fragments as Ruby with true line numbers', async () => {
    const src = [
      '<h1><%= format_title(@post) %></h1>', // line 1
      '<% if logged_in? %>', // line 2
      '  <p><%# a comment — never parsed %></p>',
      '<% end %>',
    ].join('\n');
    const out = extractEmbeddedScript('erb', src)!;
    expect(out.langId).toBe('rb');
    expect(out.masked).not.toContain('a comment');
    const p = await parseSource('show.html.erb', 'erb', src);
    const call = p.calls.find((c) => c.callee === 'format_title');
    expect(call).toBeDefined();
    expect(call!.line).toBe(1);
    expect(p.calls.map((c) => c.callee)).toContain('logged_in?');
  });

  it('keeps sibling fragments on one line as separate statements', async () => {
    const src = '<td><%= a(1) %></td><td><%= b(2) %></td>';
    const p = await parseSource('row.erb', 'erb', src);
    const callees = p.calls.map((c) => c.callee);
    expect(callees).toContain('a');
    expect(callees).toContain('b');
  });

  it('parses EJS fragments as JavaScript', async () => {
    const src = '<ul><% items.forEach(function render(it) { %><li><%= fmt(it) %></li><% }); %></ul>';
    const p = await parseSource('list.ejs', 'ejs', src);
    expect(p.calls.map((c) => c.callee)).toContain('fmt');
    expect(p.calls.map((c) => c.callee)).toContain('forEach');
  });
});

describe('module resolution for the expansion languages', () => {
  it('resolves ObjC #import and Solidity file imports against the importer dir', () => {
    const files = new Set(['ios/Service.m', 'ios/Helper.h', 'contracts/Token.sol', 'contracts/Base.sol']);
    const r = relativeResolver(files);
    expect(r.resolve('contracts/Token.sol', './Base.sol')).toBe('contracts/Base.sol');
  });
});
