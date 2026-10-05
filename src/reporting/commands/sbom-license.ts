/**
 * Turn a declared license string into a form CycloneDX 1.5 and SPDX 2.3 can
 * store without changing what the declaration means.
 *
 * A single SPDX-listed id is returned as `spdxLicenseId` so CycloneDX can emit
 * `license.id`. A `LicenseRef-*`, a `+` operator, or a compound expression is
 * returned as one canonical expression. One expression is required for
 * compounds: a CycloneDX `licenses` array means every entry applies, which
 * would turn `MIT OR LicenseRef-Acme-1.0` into an AND. `LicenseRef-*` is never
 * a `license.id` — that field is an SPDX license-list identifier.
 *
 * LicenseRef idstrings are copied unchanged. Listed ids and exceptions are
 * rewritten to their license-list spelling. Operators are uppercase with one
 * space on each side. Parentheses are kept only where SPDX precedence needs
 * them (`OR` inside `AND`).
 */
import { isValidLicenseRef } from '../../core-open/licenses/normalize.js';
import { getLicenseRecord } from '../../core-open/licenses/spdx-catalog.js';

/**
 * SPDX license-exception identifiers (SPDX License List 3.29).
 * A `WITH` clause is representable only when the exception is in this list.
 * Lookup is case-insensitive; the stored spelling is what the SBOM emits.
 */
const SPDX_EXCEPTIONS: readonly string[] = [
  '389-exception',
  'Asterisk-exception',
  'Asterisk-linking-protocols-exception',
  'Autoconf-exception-2.0',
  'Autoconf-exception-3.0',
  'Autoconf-exception-generic',
  'Autoconf-exception-generic-3.0',
  'Autoconf-exception-macro',
  'Bison-exception-1.24',
  'Bison-exception-2.2',
  'Bootloader-exception',
  'CGAL-linking-exception',
  'CLISP-exception-2.0',
  'Classpath-exception-2.0',
  'Classpath-exception-2.0-short',
  'DigiRule-FOSS-exception',
  'Digia-Qt-LGPL-exception-1.1',
  'FLTK-exception',
  'Fawkes-Runtime-exception',
  'Font-exception-2.0',
  'GCC-exception-2.0',
  'GCC-exception-2.0-note',
  'GCC-exception-3.1',
  'GNAT-exception',
  'GNOME-examples-exception',
  'GNU-compiler-exception',
  'GPL-3.0-389-ds-base-exception',
  'GPL-3.0-interface-exception',
  'GPL-3.0-linking-exception',
  'GPL-3.0-linking-source-exception',
  'GPL-CC-1.0',
  'GStreamer-exception-2005',
  'GStreamer-exception-2008',
  'Gmsh-exception',
  'Google-Patent-WebM',
  'Independent-modules-exception',
  'KiCad-libraries-exception',
  'LGPL-3.0-linking-exception',
  'LLGPL',
  'LLVM-exception',
  'LZMA-exception',
  'Libtool-exception',
  'Linux-syscall-note',
  'Nokia-Qt-exception-1.1',
  'OCCT-exception-1.0',
  'OCaml-LGPL-linking-exception',
  'OpenJDK-assembly-exception-1.0',
  'PCRE2-exception',
  'PS-or-PDF-font-exception-20170817',
  'QPL-1.0-INRIA-2004-exception',
  'Qt-GPL-exception-1.0',
  'Qt-LGPL-exception-1.1',
  'Qwt-exception-1.0',
  'RRDtool-FLOSS-exception-2.0',
  'SANE-exception',
  'SHL-2.0',
  'SHL-2.1',
  'SWI-exception',
  'Simple-Library-Usage-exception',
  'Spelling-Provider-LGPL-exception',
  'Swift-exception',
  'Texinfo-exception',
  'UBDL-exception',
  'Universal-FOSS-exception-1.0',
  'WxWindows-exception-3.1',
  'cryptsetup-OpenSSL-exception',
  'eCos-exception-2.0',
  'erlang-otp-linking-exception',
  'fmt-exception',
  'freertos-exception-2.0',
  'gnu-javamail-exception',
  'harbour-exception',
  'i2p-gpl-java-exception',
  'kvirc-openssl-exception',
  'libpri-OpenH323-exception',
  'mif-exception',
  'mxml-exception',
  'openvpn-openssl-exception',
  'polyparse-exception',
  'romic-exception',
  'rsync-linking-exception',
  'sqlitestudio-OpenSSL-exception',
  'stunnel-exception',
  'u-boot-exception-2.0',
  'vsftpd-openssl-exception',
  'x11vnc-openssl-exception',
];

const BY_LOWER = new Map<string, string>();
for (const id of SPDX_EXCEPTIONS) BY_LOWER.set(id.toLowerCase(), id);

/** Canonical SPDX exception id, or undefined when `value` is not on the list. */
export function canonicalSpdxException(value: string): string | undefined {
  return BY_LOWER.get(value.trim().toLowerCase());
}

export interface RepresentedLicense {
  /**
   * Set when the declaration is exactly one SPDX-listed license id, with no
   * `+`, exception, or compound operator. Null for a LicenseRef or expression.
   */
  spdxLicenseId: string | null;
  /** SPDX expression written to `licenseDeclared`, and to CycloneDX when `spdxLicenseId` is null. */
  expression: string;
  /** `LicenseRef-*` ids used in `expression`, sorted and de-duplicated. */
  licenseRefs: readonly string[];
}

type Tok =
  | { kind: 'id'; value: string }
  | { kind: 'op'; value: 'AND' | 'OR' | 'WITH' | '+' }
  | { kind: 'lparen' }
  | { kind: 'rparen' };

type LicNode = { kind: 'lic'; id: string; orLater: boolean; ref: boolean };
type Node =
  | LicNode
  | { kind: 'with'; base: LicNode; exception: string }
  | { kind: 'and'; parts: Node[] }
  | { kind: 'or'; parts: Node[] };

interface ParseState {
  tokens: Tok[];
  i: number;
}

function peek(state: ParseState): Tok | undefined {
  return state.tokens[state.i];
}

function isOp(tok: Tok | undefined, value: 'AND' | 'OR' | 'WITH' | '+'): boolean {
  return tok?.kind === 'op' && tok.value === value;
}

/** SPDX tokens. Operators are recognised only as their own whitespace-delimited words. */
function tokenize(input: string): Tok[] | null {
  const tokens: Tok[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++;
      continue;
    }
    if (ch === '(') {
      tokens.push({ kind: 'lparen' });
      i++;
      continue;
    }
    if (ch === ')') {
      tokens.push({ kind: 'rparen' });
      i++;
      continue;
    }
    if (ch === '+') {
      tokens.push({ kind: 'op', value: '+' });
      i++;
      continue;
    }
    if (!/[A-Za-z0-9]/.test(ch)) return null;
    const start = i;
    i++;
    while (i < input.length && /[A-Za-z0-9.-]/.test(input[i]!)) i++;
    const value = input.slice(start, i);
    const upper = value.toUpperCase();
    if (upper === 'AND' || upper === 'OR' || upper === 'WITH') {
      tokens.push({ kind: 'op', value: upper });
    } else {
      tokens.push({ kind: 'id', value });
    }
  }
  return tokens;
}

function resolveLicense(token: string, orLater: boolean): LicNode | null {
  // Prefix is case-sensitive. A custom ref is not rewritten, and `+` does not apply to it.
  if (token.startsWith('LicenseRef-')) {
    if (orLater || !isValidLicenseRef(token)) return null;
    return { kind: 'lic', id: token, orLater: false, ref: true };
  }
  const rec = getLicenseRecord(token);
  if (!rec) return null;
  // Catalog entry whose canonical id is itself a LicenseRef (LicenseRef-Proprietary).
  if (isValidLicenseRef(rec.spdxId)) {
    if (orLater) return null;
    return { kind: 'lic', id: rec.spdxId, orLater: false, ref: true };
  }
  return { kind: 'lic', id: rec.spdxId, orLater, ref: false };
}

function parseOr(state: ParseState): Node | null {
  const first = parseAnd(state);
  if (!first) return null;
  if (!isOp(peek(state), 'OR')) return first;
  const parts = [first];
  while (isOp(peek(state), 'OR')) {
    state.i++;
    const next = parseAnd(state);
    if (!next) return null;
    parts.push(next);
  }
  return { kind: 'or', parts };
}

function parseAnd(state: ParseState): Node | null {
  const first = parseWith(state);
  if (!first) return null;
  if (!isOp(peek(state), 'AND')) return first;
  const parts = [first];
  while (isOp(peek(state), 'AND')) {
    state.i++;
    const next = parseWith(state);
    if (!next) return null;
    parts.push(next);
  }
  return { kind: 'and', parts };
}

function parseWith(state: ParseState): Node | null {
  const base = parsePrimary(state);
  if (!base) return null;
  if (!isOp(peek(state), 'WITH')) return base;
  // `WITH` binds to one simple license, not to a parenthesised compound.
  if (base.kind !== 'lic') return null;
  state.i++;
  const exceptionTok = peek(state);
  if (!exceptionTok || exceptionTok.kind !== 'id') return null;
  const exception = canonicalSpdxException(exceptionTok.value);
  if (!exception) return null;
  state.i++;
  return { kind: 'with', base, exception };
}

function parsePrimary(state: ParseState): Node | null {
  const tok = peek(state);
  if (!tok) return null;
  if (tok.kind === 'lparen') {
    state.i++;
    const inner = parseOr(state);
    const close = peek(state);
    if (!inner || close?.kind !== 'rparen') return null;
    state.i++;
    return inner;
  }
  if (tok.kind !== 'id') return null;
  state.i++;
  let orLater = false;
  if (isOp(peek(state), '+')) {
    orLater = true;
    state.i++;
  }
  return resolveLicense(tok.value, orLater);
}

function serialize(node: Node, parent: 'top' | 'and' | 'or'): string {
  switch (node.kind) {
    case 'lic':
      return node.orLater ? `${node.id}+` : node.id;
    case 'with':
      return `${serialize(node.base, 'top')} WITH ${node.exception}`;
    case 'and':
      return node.parts.map((part) => serialize(part, 'and')).join(' AND ');
    case 'or': {
      const inner = node.parts.map((part) => serialize(part, 'or')).join(' OR ');
      return parent === 'and' ? `(${inner})` : inner;
    }
  }
}

function collectLicenseRefs(node: Node, out: string[]): void {
  switch (node.kind) {
    case 'lic':
      if (node.ref) out.push(node.id);
      return;
    case 'with':
      collectLicenseRefs(node.base, out);
      return;
    case 'and':
    case 'or':
      for (const part of node.parts) collectLicenseRefs(part, out);
      return;
  }
}

function sortedUnique(ids: string[]): string[] {
  return [...new Set(ids)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function singleListedId(node: Node): string | null {
  if (node.kind === 'lic' && !node.orLater && !node.ref) return node.id;
  return null;
}

/**
 * Parse `raw` as an SPDX license expression. Returns null when it cannot be
 * stored: unknown id, ill-formed `LicenseRef-*`, unknown exception, or syntax
 * the SPDX expression grammar does not allow. Empty input is null — callers
 * treat absence separately and must not guess a license.
 */
export function representDeclaredLicense(raw: string): RepresentedLicense | null {
  const input = raw.trim();
  if (!input) return null;
  const tokens = tokenize(input);
  if (!tokens || tokens.length === 0) return null;
  const state: ParseState = { tokens, i: 0 };
  const node = parseOr(state);
  if (!node || state.i !== tokens.length) return null;
  const refs: string[] = [];
  collectLicenseRefs(node, refs);
  const listed = singleListedId(node);
  if (listed) {
    return { spdxLicenseId: listed, expression: listed, licenseRefs: [] };
  }
  return { spdxLicenseId: null, expression: serialize(node, 'top'), licenseRefs: sortedUnique(refs) };
}
