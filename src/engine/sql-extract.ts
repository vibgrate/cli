/**
 * Deterministic SQL DDL extraction — no tree-sitter grammar required.
 * Tables, views, and REFERENCES relationships only (schema topology).
 */

import type { FileParse, RawDef, RawHeritage } from './types.js';
import { hashString } from './hash.js';

export function parseSqlFile(rel: string, source: string): FileParse {
  const defs: RawDef[] = [];
  const heritage: RawHeritage[] = [];

  const cleaned = source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/--[^\n]*/g, '');

  const tableRe =
    /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:TEMP(?:ORARY)?\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([`"[\w.]+)/gi;
  const viewRe =
    /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:TEMP(?:ORARY)?\s+)?VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?([`"[\w.]+)/gi;
  const fkRe = /\bFOREIGN\s+KEY\s*\([^)]+\)\s*REFERENCES\s+([`"[\w.]+)/gi;
  const colRefRe = /\bREFERENCES\s+([`"[\w.]+)/gi;

  let m: RegExpExecArray | null;
  while ((m = tableRe.exec(cleaned)) !== null) {
    const name = stripIdent(m[1]);
    if (!name) continue;
    const line = lineOf(cleaned, m.index);
    defs.push({
      kind: 'class',
      name,
      qualifiedName: name,
      startLine: line,
      endLine: line,
      startByte: m.index,
      endByte: m.index + m[0].length,
      signature: `TABLE ${name}`,
    });
  }

  while ((m = viewRe.exec(cleaned)) !== null) {
    const name = stripIdent(m[1]);
    if (!name) continue;
    const line = lineOf(cleaned, m.index);
    defs.push({
      kind: 'interface',
      name,
      qualifiedName: name,
      startLine: line,
      endLine: line,
      startByte: m.index,
      endByte: m.index + m[0].length,
      signature: `VIEW ${name}`,
    });
  }

  const refSeen = new Set<string>();
  for (const re of [fkRe, colRefRe]) {
    re.lastIndex = 0;
    while ((m = re.exec(cleaned)) !== null) {
      const target = stripIdent(m[1]);
      if (!target || refSeen.has(`${m.index}:${target}`)) continue;
      refSeen.add(`${m.index}:${target}`);
      heritage.push({ superName: target, byte: m.index, kind: 'extends' });
    }
  }

  defs.sort((a, b) => a.startByte - b.startByte || a.name.localeCompare(b.name));

  return {
    rel,
    lang: 'sql',
    hash: hashString(source),
    bytes: Buffer.byteLength(source, 'utf8'),
    defs,
    calls: [],
    imports: [],
    heritage,
    typeRefs: [],
    guards: [],
  };
}

function stripIdent(raw: string): string {
  return raw.replace(/^[`"[]+|[`"\]]+$/g, '').split('.').pop() ?? raw;
}

function lineOf(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i++) {
    if (source[i] === '\n') line++;
  }
  return line;
}
