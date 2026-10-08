import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * npm listing fields for the package published as @vibgrate/cli.
 * The monorepo mirror keeps name `@vibgrate/cli-public` plus `_publishedAs`;
 * the public repo uses name `@vibgrate/cli`. Homepage, description, and
 * keywords are the same in both.
 */
const LISTING_DESCRIPTION =
  'Vibgrate CLI scans your manifests — never your source — and scores drift (DriftScore) and exposure (RiskScore) separately. Free, offline, in about a minute.';

describe('npm listing metadata', () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
    name: string;
    _publishedAs?: string;
    homepage: string;
    description: string;
    keywords: string[];
  };

  it('is the package published as @vibgrate/cli', () => {
    const publishedName = pkg._publishedAs ?? pkg.name;
    expect(publishedName).toBe('@vibgrate/cli');
  });

  it('points homepage at the CLI page', () => {
    expect(pkg.homepage).toBe('https://vibgrate.com/cli');
  });

  it('uses the directory short description', () => {
    expect(pkg.description).toBe(LISTING_DESCRIPTION);
  });

  it('keeps listing keywords, including drift, eol, sca, and mcp', () => {
    const required = [
      'code-graph',
      'codebase-intelligence',
      'ast',
      'tree-sitter',
      'mcp',
      'ai-agents',
      'drift',
      'eol',
      'sca',
      'deterministic',
      'impact-analysis',
      'cli',
    ];
    for (const keyword of required) {
      expect(pkg.keywords).toContain(keyword);
    }
    expect(pkg.keywords.every((keyword) => keyword === keyword.toLowerCase())).toBe(true);
  });
});
