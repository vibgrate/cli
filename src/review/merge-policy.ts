/**
 * Merge policy for `.vibgrate/review/merge.md`.
 *
 * Docs-only changes may be approved. A change to the merge policy file itself
 * must be refused. Absence of findings is never a reason to approve — that is
 * not a certification.
 */

export const MERGE_POLICY_PATH = '.vibgrate/review/merge.md';

export type MergeDecision = 'approve' | 'refuse' | 'withhold';

export interface MergePolicyInput {
  enabled: boolean;
  requireHuman: string[];
  changedFiles: string[];
}

export interface MergePolicyResult {
  decision: MergeDecision;
  reasons: string[];
}

const DOC_EXT = /\.(md|mdx|rst|txt|adoc)$/i;

export function isMergePolicyPath(filePath: string): boolean {
  return normalize(filePath) === MERGE_POLICY_PATH;
}

export function isDocumentationPath(filePath: string): boolean {
  const value = normalize(filePath);
  if (isMergePolicyPath(value)) return false;
  const base = value.split('/').pop() ?? value;
  if (/^(readme|changelog|contributing|license|authors|notice)(\.|$)/i.test(base)) return true;
  if (value.startsWith('docs/') || value.startsWith('documentation/')) return true;
  return DOC_EXT.test(value);
}

export function evaluateMergePolicy(input: MergePolicyInput): MergePolicyResult {
  if (!input.enabled) {
    return { decision: 'withhold', reasons: ['Merge policy is present but disabled.'] };
  }

  const files = input.changedFiles.map(normalize).filter(Boolean);
  if (files.length === 0) {
    return {
      decision: 'withhold',
      reasons: ['No changed files were supplied. Absence of a file list is not a certification.'],
    };
  }

  if (files.some(isMergePolicyPath)) {
    return {
      decision: 'refuse',
      reasons: [`This change edits \`${MERGE_POLICY_PATH}\`. Merge policy must not approve a change to itself.`],
    };
  }

  const humanHits = files.filter((file) =>
    input.requireHuman.some((pattern) => matchSimpleGlob(pattern, file)),
  );
  if (humanHits.length > 0) {
    return {
      decision: 'refuse',
      reasons: [`require-human paths changed: ${humanHits.map((p) => `\`${p}\``).join(', ')}`],
    };
  }

  if (files.every(isDocumentationPath)) {
    return {
      decision: 'approve',
      reasons: [
        'Every changed file is documentation. This is a time saver, not a security proof.',
        'Absence of findings is not a certification.',
      ],
    };
  }

  return {
    decision: 'withhold',
    reasons: [
      'This change is not docs-only. Merge policy will not approve it.',
      'Absence of findings is not a certification.',
    ],
  };
}

function normalize(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\.\//, '');
}

/** Enough glob for require-human / ignore-style patterns. Not a full fnmatch. */
export function matchSimpleGlob(pattern: string, value: string): boolean {
  const p = normalize(pattern);
  const v = normalize(value);
  let source = '';
  for (let i = 0; i < p.length; i += 1) {
    const char = p[i];
    if (char === '*' && p[i + 1] === '*') {
      if (p[i + 2] === '/') {
        source += '(?:.*/)?';
        i += 2;
      } else {
        source += '.*';
        i += 1;
      }
      continue;
    }
    if (char === '*') {
      source += '[^/]*';
      continue;
    }
    if (char === '?') {
      source += '[^/]';
      continue;
    }
    if (char && /[.+^${}()|[\]\\]/.test(char)) {
      source += `\\${char}`;
      continue;
    }
    source += char;
  }
  return new RegExp(`^${source}$`).test(v);
}
