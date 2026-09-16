import { describe, it, expect } from 'vitest';
import { extractIdentifiers } from '../runtime/identifier-mask.js';
import { buildIdentifierTrieFromGraph } from '../runtime/identifier-trie.js';
import { enforceIdentifiersInPatch, enforceIdentifiersInText, patchBodies } from './identifier-enforce.js';
import { PATCH_IR_SCHEMA_VERSION, type PatchIR } from './patch-ir.js';

function patch(ops: PatchIR['operations']): PatchIR {
  return {
    schemaVersion: PATCH_IR_SCHEMA_VERSION,
    operations: ops,
    assumptions: [],
    requestedVerification: [],
    provenance: { format: 'structured-json' },
  };
}

function extractAllow(text: string): string[] {
  return extractIdentifiers(text);
}

describe('identifier-enforce', () => {
  const trie = buildIdentifierTrieFromGraph({
    nodes: [{ name: 'readConfig', qualifiedName: 'app.readConfig' }, { name: 'Config' }],
  });

  it('allows known identifiers', () => {
    const r = enforceIdentifiersInText('return readConfig() as Config;', trie);
    expect(r.ok).toBe(true);
  });

  it('does not invent-check Hello in a $1 regex substitution when callablesOnly', () => {
    const r = enforceIdentifiersInText('Hello, $1!', trie, { callablesOnly: true });
    expect(r.ok).toBe(true);
    expect(r.unknown).not.toContain('Hello');
  });

  it('still blocks an invented callable after stripping strings', () => {
    const r = enforceIdentifiersInText('return "Hello, " + ghostFn() + "!";', trie, { callablesOnly: true });
    expect(r.ok).toBe(false);
    expect(r.unknown).toContain('ghostFn');
  });

  it('blocks unknown identifiers in text', () => {
    const r = enforceIdentifiersInText('return ghostFn();', trie);
    expect(r.ok).toBe(false);
    expect(r.unknown).toContain('ghostFn');
  });

  it('allows identifiers already present in the file / allow list', () => {
    const r = enforceIdentifiersInText('const timeout = 5000;', trie, {
      allow: extractAllow('const timeout = 0;'),
    });
    expect(r.ok).toBe(true);
  });

  it('ignores prose in comments by default', () => {
    const r = enforceIdentifiersInText('/** formats a report */\nexport function readConfig() {}', trie);
    expect(r.ok).toBe(true);
  });

  it('allows a requireVerified-style helper declared in the same replace body', () => {
    const body = [
      'export function requireVerified(user: { verified: boolean }) {',
      '  if (!user.verified) throw new Error("unverified");',
      '  return user;',
      '}',
      'export function readConfig() { return requireVerified({ verified: true }); }',
    ].join('\n');
    const r = enforceIdentifiersInText(body, trie, { callablesOnly: true });
    expect(r.ok).toBe(true);
    expect(r.unknown).not.toContain('requireVerified');
  });

  it('allows const and class bindings declared in the same body', () => {
    const r = enforceIdentifiersInText(
      'export const requireVerified = (user: { verified: boolean }) => user;\nclass Gate {}\nnew Gate();\nrequireVerified({ verified: true });',
      trie,
      { callablesOnly: true },
    );
    expect(r.ok).toBe(true);
  });

  it('still blocks a call to a missing external symbol', () => {
    const r = enforceIdentifiersInText(
      'export function requireVerified() { return inventGhostSymbol(); }',
      trie,
      { callablesOnly: true },
    );
    expect(r.ok).toBe(false);
    expect(r.unknown).toContain('inventGhostSymbol');
    expect(r.unknown).not.toContain('requireVerified');
  });

  it('apply_patch allows a newly declared helper in the replacement', () => {
    const p = patch([
      {
        op: 'replace-text',
        file: 'a.ts',
        search: 'readConfig',
        replace:
          'export function requireVerified() { return 1; }\nfunction readConfig() { return requireVerified(); }',
      },
    ]);
    const r = enforceIdentifiersInPatch(p, trie, {
      readFile: () => 'export function readConfig() { return 1; }\n',
    });
    expect(r.ok).toBe(true);
    expect(r.unknown).not.toContain('requireVerified');
  });

  it('blocks apply_patch when replacement invents symbols', () => {
    const p = patch([
      {
        op: 'replace-text',
        file: 'a.ts',
        search: 'readConfig',
        replace: 'function readConfig() { return inventNewThing(); }',
      },
    ]);
    const r = enforceIdentifiersInPatch(p, trie, {
      readFile: () => 'export function readConfig() { return 1; }\n',
    });
    expect(r.ok).toBe(false);
    expect(r.unknown).toContain('inventNewThing');
  });

  it('allows patch when only graph symbols appear', () => {
    const p = patch([
      {
        op: 'replace-text',
        file: 'a.ts',
        search: 'x',
        replace: 'const x: Config = readConfig();',
      },
    ]);
    expect(enforceIdentifiersInPatch(p, trie).ok).toBe(true);
  });

  it('allows local var edits that re-use identifiers already in the file', () => {
    const p = patch([
      {
        op: 'replace-text',
        file: 'src/scan.ts',
        search: 'const timeout = 0;',
        replace: 'const timeout = 5000;',
      },
    ]);
    const r = enforceIdentifiersInPatch(p, trie, {
      readFile: () => 'export function scanDir() {\n  const timeout = 0;\n  return timeout;\n}\n',
    });
    expect(r.ok).toBe(true);
  });

  it('no trie → always ok', () => {
    expect(enforceIdentifiersInText('anythingGoes', null).ok).toBe(true);
    expect(enforceIdentifiersInPatch(patch([{ op: 'delete-file', file: 'a.ts' }]), undefined).ok).toBe(true);
  });

  it('patchBodies extracts replacement text', () => {
    const bodies = patchBodies(
      patch([{ op: 'create-file', file: 'n.ts', content: 'export const readConfig = 1;' }]),
    );
    expect(bodies.join('')).toContain('readConfig');
  });
});
