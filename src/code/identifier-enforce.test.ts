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
