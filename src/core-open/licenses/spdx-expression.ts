// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
/**
 * Minimal SPDX license-expression parser.
 *
 * Handles the subset of the SPDX expression grammar seen in real-world
 * manifests: compound expressions with OR / AND, exceptions via WITH, the
 * "or later" `+` operator, and parenthesised grouping. The goal is not full
 * grammar conformance but reliable extraction of the constituent license ids
 * and the operator that joins them so downstream risk logic can reason about
 * choice (OR) vs. conjunction (AND).
 */

export interface ParsedLicenseExpression {
  /** All distinct license ids referenced (without the trailing `+`). */
  licenseIds: string[];
  /** Exceptions referenced via WITH. */
  exceptions: string[];
  /** Dominant join operator: OR when the user may choose, AND when all apply. */
  operator: 'OR' | 'AND' | 'SINGLE';
  /** True when any term used the `+` ("or later") operator. */
  orLater: boolean;
  /** The normalized, re-serialised expression. */
  normalized: string;
}

const TOKEN_RE = /\(|\)|\bWITH\b|\bAND\b|\bOR\b|[^\s()]+/gi;

/**
 * Parse an SPDX expression into its parts. Tolerant of malformed input —
 * returns whatever license-like tokens it can find.
 */
export function parseLicenseExpression(raw: string): ParsedLicenseExpression {
  const input = (raw ?? '').trim();
  const licenseIds: string[] = [];
  const exceptions: string[] = [];
  let hasOr = false;
  let hasAnd = false;
  let orLater = false;
  let expectException = false;

  const tokens = input.match(TOKEN_RE) ?? [];
  for (const token of tokens) {
    const upper = token.toUpperCase();
    if (token === '(' || token === ')') continue;
    if (upper === 'OR') {
      hasOr = true;
      expectException = false;
      continue;
    }
    if (upper === 'AND') {
      hasAnd = true;
      expectException = false;
      continue;
    }
    if (upper === 'WITH') {
      expectException = true;
      continue;
    }
    if (expectException) {
      if (!exceptions.includes(token)) exceptions.push(token);
      expectException = false;
      continue;
    }
    // License id term
    let id = token;
    if (id.endsWith('+')) {
      orLater = true;
      id = id.slice(0, -1);
    }
    if (id && !licenseIds.includes(id)) licenseIds.push(id);
  }

  const operator: ParsedLicenseExpression['operator'] = hasOr
    ? 'OR'
    : hasAnd
      ? 'AND'
      : 'SINGLE';

  return {
    licenseIds,
    exceptions,
    operator,
    orLater,
    normalized: serialise(licenseIds, exceptions, operator, orLater, input),
  };
}

function serialise(
  ids: string[],
  exceptions: string[],
  operator: ParsedLicenseExpression['operator'],
  orLater: boolean,
  original: string,
): string {
  if (ids.length === 0) return original.trim();
  if (ids.length === 1) {
    let out = ids[0]!;
    if (orLater && !out.endsWith('+')) out += '+';
    if (exceptions.length > 0) out += ` WITH ${exceptions.join(' WITH ')}`;
    return out;
  }
  const joiner = operator === 'AND' ? ' AND ' : ' OR ';
  return ids.join(joiner);
}

/** True when the string looks like a compound SPDX expression. */
export function isCompoundExpression(raw: string): boolean {
  return /\b(?:AND|OR|WITH)\b|\+\s*$|\(/i.test(raw);
}
