import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  scanArchitecture,
  scanArchitectureBundle,
  scanProjectArchitecture,
  aggregateSolutionArchitecture,
  buildProjectArchitectureMermaid,
  mermaidFromArchitecture,
  refineArchitectureWithGraph,
  refineArchitectureResult,
  applyAstRoles,
  refineArchitectureWithAstRoles,
  matchAstRolesFromSource,
  type ArchitectureResult,
} from '../../core-open/index.js';
import { parseSource } from '../../engine/parse.js';
import { fileRolesFromParses, fileRolesFromParseCache } from '../../engine/ast-roles.js';
import { loadCache } from '../../engine/cache.js';
import { grammarSetVersion } from '../../engine/grammars.js';
import { toolchainGrammarSetVersion } from '../../engine/toolchain/grammars.js';
import { VERSION } from '../../version.js';

describe('vendored architecture export', () => {
  it('re-exports the core-open architecture scanner', () => {
    expect(typeof scanArchitecture).toBe('function');
    expect(typeof scanArchitectureBundle).toBe('function');
    expect(typeof scanProjectArchitecture).toBe('function');
    expect(typeof aggregateSolutionArchitecture).toBe('function');
    expect(typeof buildProjectArchitectureMermaid).toBe('function');
    expect(typeof mermaidFromArchitecture).toBe('function');
    expect(typeof refineArchitectureWithGraph).toBe('function');
    expect(typeof refineArchitectureResult).toBe('function');
    expect(typeof applyAstRoles).toBe('function');
    expect(typeof refineArchitectureWithAstRoles).toBe('function');
    expect(typeof matchAstRolesFromSource).toBe('function');
  });
});

describe('parse-time AST role extract', () => {
  it('reuses the graph parse to confirm a @RestController not under controller/', async () => {
    const src = `package com.example.app;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class BillingOps {
    @GetMapping("/ops")
    public String ops() {
        return "ok";
    }
}
`;
    const parsed = await parseSource('src/app/BillingOps.java', 'java', src);
    const hits = fileRolesFromParses([parsed]);
    expect(hits.some((h) => h.role === 'controller' && h.layer === 'routing')).toBe(true);

    const result: ArchitectureResult = {
      archetype: 'spring',
      archetypeConfidence: 0.8,
      layers: [],
      totalClassified: 0,
      unclassified: 1,
      unclassifiedFiles: ['src/app/BillingOps.java'],
    };
    applyAstRoles(result, hits);
    expect(result.classified?.[0]?.role).toBe('controller');
    expect(result.classified?.[0]?.layer).toBe('routing');
    expect(mermaidFromArchitecture(result).startsWith('flowchart TD')).toBe(true);
  });

  it('recovers file roles from the versioned parse cache', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vg-parse-roles-'));
    try {
      expect(fileRolesFromParseCache(root)).toEqual([]);

      const src = `package com.example.app;

import org.springframework.web.bind.annotation.RestController;

@RestController
public class BillingOps {}
`;
      const parsed = await parseSource('src/app/BillingOps.java', 'java', src);
      const grammars = `${grammarSetVersion()}+${toolchainGrammarSetVersion()}`;
      const cache = loadCache(root, { toolVersion: VERSION, grammars });
      cache.set(parsed.rel, parsed);
      cache.save();

      const recovered = fileRolesFromParseCache(root);
      expect(recovered.some((h) => h.role === 'controller' && h.filePath === 'src/app/BillingOps.java')).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
