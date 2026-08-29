/**
 * Declared intent — what humans *said* this codebase should look like.
 *
 * Read from the agent-instruction files a repository already maintains
 * (`CLAUDE.md`, `AGENTS.md`, `.cursorrules`, …) plus `.vibgrate/review.toml`.
 * These are the same files an AI agent is told to obey, which is exactly why
 * Review should read them: if the repository tells an agent "use the repository
 * pattern, never call the ORM from a handler", a change that does the opposite
 * is a regression against a stated intention, not a matter of taste.
 *
 * Intent is a **hint, not a fact**. It seeds the dominance vote
 * (`INTENT_BOOST`) and it can name a target pattern, but it never on its own
 * produces a finding: prose in a markdown file is not evidence about code. The
 * graph and the scanners still have to show the change actually did the thing.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Files that conventionally carry agent/contributor instructions. */
export const INTENT_FILES = [
  'CLAUDE.md',
  'AGENTS.md',
  '.cursorrules',
  '.github/copilot-instructions.md',
  'CONTRIBUTING.md',
] as const;

/** Cap on bytes read per file — instructions are prose, not a corpus. */
const MAX_INTENT_BYTES = 256 * 1024;

export interface DeclaredIntent {
  /** Architecture/layering patterns named in prose (`layered`, `clean`, …). */
  patterns: string[];
  /** The files intent was actually read from — evidence for the capsule. */
  sources: string[];
  /** Verbatim lines that produced a pattern, capped and trimmed. */
  citations: { file: string; line: number; text: string }[];
}

/**
 * Architecture vocabulary we recognise. Deliberately small: an unrecognised
 * word is left alone rather than guessed at, because a wrong `target_pattern`
 * silently changes every alignment verdict in the receipt.
 */
const PATTERN_VOCABULARY: readonly { pattern: string; match: RegExp }[] = [
  { pattern: 'clean', match: /\bclean architecture\b/i },
  { pattern: 'hexagonal', match: /\bhexagonal\b|\bports?\s+and\s+adapters?\b/i },
  { pattern: 'onion', match: /\bonion architecture\b/i },
  { pattern: 'layered', match: /\blayered architecture\b|\bn-tier\b|\bthree-tier\b/i },
  { pattern: 'vertical-slice', match: /\bvertical slices?\b|\bfeature slices?\b/i },
  { pattern: 'mvc', match: /\bMVC\b/ },
  { pattern: 'mvvm', match: /\bMVVM\b/ },
];

/**
 * Read declared intent from a repository.
 *
 * Never throws: an unreadable or absent instruction file means "nothing was
 * declared", which is a legitimate state, not an error.
 */
export function readDeclaredIntent(root: string, files: readonly string[] = INTENT_FILES): DeclaredIntent {
  const patterns = new Set<string>();
  const sources: string[] = [];
  const citations: DeclaredIntent['citations'] = [];

  for (const rel of files) {
    const abs = path.join(root, rel);
    let text: string;
    try {
      const stat = fs.statSync(abs);
      if (!stat.isFile() || stat.size > MAX_INTENT_BYTES) continue;
      text = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    let matchedHere = false;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      for (const { pattern, match } of PATTERN_VOCABULARY) {
        if (!match.test(lines[i])) continue;
        patterns.add(pattern);
        matchedHere = true;
        if (citations.length < 12) {
          citations.push({ file: rel, line: i + 1, text: lines[i].trim().slice(0, 200) });
        }
      }
    }
    if (matchedHere) sources.push(rel);
  }

  return { patterns: [...patterns].sort(), sources, citations };
}
