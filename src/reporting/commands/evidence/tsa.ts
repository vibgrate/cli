// ── RFC 3161 trusted timestamping ──
//
// Requests a real RFC 3161 timestamp token over the evidence result digest, so
// a bundle carries proof of *when* it was produced, anchored to a trusted
// third-party Time-Stamping Authority (TSA) rather than the local clock.
//
// The token we store (timestamp.tsr) is a standards-compliant RFC 3161
// TimeStampResp — fully verifiable by any third party with, e.g.,
// `openssl ts -verify`. Our own `verify` confirms the token's message imprint
// binds to this exact result and surfaces the trusted genTime; it does not
// re-verify the TSA's signature chain (that needs the TSA CA and is left to
// standard tooling), and it says so honestly rather than implying more.
//
// Zero dependencies: a minimal DER encoder/parser over node:crypto hashes.

import * as crypto from 'node:crypto';
import { CliError, ExitCode } from '../../../util/exit.js';

// ── minimal DER ──

const TAG = { INTEGER: 0x02, BIT_STRING: 0x03, OCTET_STRING: 0x04, NULL: 0x05, OID: 0x06, SEQUENCE: 0x30, SET: 0x31, BOOLEAN: 0x01, GENERALIZED_TIME: 0x18 } as const;
const OID_SHA256 = Buffer.from('608648016503040201', 'hex'); // 2.16.840.1.101.3.4.2.1

function derLen(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  let v = n;
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v >>>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
function der(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLen(content.length), content]);
}
function derInt(n: number): Buffer {
  let hex = n.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  let bytes = Buffer.from(hex, 'hex');
  if (bytes[0] & 0x80) bytes = Buffer.concat([Buffer.from([0]), bytes]); // keep positive
  return der(TAG.INTEGER, bytes);
}

/** RFC 3161 TimeStampReq over a sha256 digest, requesting the TSA cert back. */
export function buildTimeStampReq(digest: Buffer): Buffer {
  const algId = der(TAG.SEQUENCE, Buffer.concat([der(TAG.OID, OID_SHA256), der(TAG.NULL, Buffer.alloc(0))]));
  const messageImprint = der(TAG.SEQUENCE, Buffer.concat([algId, der(TAG.OCTET_STRING, digest)]));
  const version = derInt(1);
  const nonce = der(TAG.INTEGER, crypto.randomBytes(16));
  const certReq = der(TAG.BOOLEAN, Buffer.from([0xff]));
  return der(TAG.SEQUENCE, Buffer.concat([version, messageImprint, nonce, certReq]));
}

interface DerNode {
  tag: number;
  content: Buffer;
  children: DerNode[];
}
function parseDer(buf: Buffer, start = 0, end = buf.length): DerNode[] {
  const nodes: DerNode[] = [];
  let i = start;
  while (i < end - 1) {
    const tag = buf[i];
    let j = i + 1;
    let len = buf[j++];
    if (len & 0x80) {
      const n = len & 0x7f;
      len = 0;
      for (let k = 0; k < n; k++) len = (len << 8) | buf[j++];
    }
    const contentStart = j;
    const contentEnd = j + len;
    if (contentEnd > end) break;
    const content = buf.subarray(contentStart, contentEnd);
    const constructed = (tag & 0x20) !== 0;
    nodes.push({ tag, content, children: constructed ? parseDer(buf, contentStart, contentEnd) : [] });
    i = contentEnd;
  }
  return nodes;
}

/** Recursively find the TSTInfo: an OCTET STRING whose content parses as a
 *  SEQUENCE beginning INTEGER, OID, SEQUENCE (version, policy, messageImprint). */
function findTstInfo(nodes: DerNode[]): DerNode | null {
  for (const node of nodes) {
    if (node.tag === TAG.OCTET_STRING) {
      const inner = parseDer(node.content);
      const seq = inner[0];
      if (seq && seq.tag === TAG.SEQUENCE && seq.children[0]?.tag === TAG.INTEGER && seq.children[1]?.tag === TAG.OID && seq.children[2]?.tag === TAG.SEQUENCE) {
        return seq;
      }
    }
    if (node.children.length) {
      const found = findTstInfo(node.children);
      if (found) return found;
    }
  }
  return null;
}

export interface TstToken {
  imprintHex: string;
  genTime: string; // ISO 8601
  hashAlgoOidHex: string;
}

/** Parse a stored RFC 3161 token (TimeStampResp DER) to its imprint + genTime. */
export function parseTimestampToken(tsr: Buffer): TstToken {
  const tst = findTstInfo(parseDer(tsr));
  if (!tst) throw new CliError('timestamp token does not contain a parseable TSTInfo', ExitCode.ERROR);
  const messageImprint = tst.children[2];
  const algId = messageImprint.children[0];
  const hashedMessage = messageImprint.children[1];
  const genTimeNode = tst.children.find((c) => c.tag === TAG.GENERALIZED_TIME);
  if (!hashedMessage || !genTimeNode) throw new CliError('timestamp token TSTInfo missing imprint or genTime', ExitCode.ERROR);
  return {
    imprintHex: hashedMessage.content.toString('hex'),
    hashAlgoOidHex: algId?.children[0]?.content.toString('hex') ?? '',
    genTime: parseGeneralizedTime(genTimeNode.content.toString('ascii')),
  };
}

/** ASN.1 GeneralizedTime (e.g. 20260722100000Z or with fractional secs) → ISO. */
function parseGeneralizedTime(g: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\.\d+)?Z?$/.exec(g.trim());
  if (!m) return g;
  const [, y, mo, d, h, mi, s, frac] = m;
  return `${y}-${mo}-${d}T${h}:${mi}:${s}${frac ?? ''}Z`;
}

export interface TimestampVerifyResult {
  present: boolean;
  imprintMatches: boolean;
  genTime?: string;
  reason: string;
}

/** Confirm the token's imprint binds to `digest` and surface the trusted time.
 *  Honest: this does NOT verify the TSA's signature chain — use
 *  `openssl ts -verify` with the TSA CA for full cryptographic verification. */
export function verifyTimestamp(tsr: Buffer, digestHex: string): TimestampVerifyResult {
  let token: TstToken;
  try {
    token = parseTimestampToken(tsr);
  } catch (e) {
    return { present: true, imprintMatches: false, reason: e instanceof Error ? e.message : 'unparseable timestamp token' };
  }
  const imprintMatches = token.imprintHex.toLowerCase() === digestHex.toLowerCase();
  return {
    present: true,
    imprintMatches,
    genTime: token.genTime,
    reason: imprintMatches
      ? `RFC 3161 token binds to this result at ${token.genTime} (TSA signature chain not re-verified here — use \`openssl ts -verify\`)`
      : 'RFC 3161 token imprint does not match this result',
  };
}

/** Request a timestamp from an RFC 3161 TSA over the result digest. Returns the
 *  raw TimeStampResp bytes to store as timestamp.tsr. Best-effort: a network or
 *  TSA error is actionable, and callers fall back to an honest local-clock. */
export async function requestTimestamp(tsaUrl: string, digest: Buffer): Promise<Buffer> {
  if (typeof fetch !== 'function') throw new CliError('network fetch unavailable — cannot reach the TSA', ExitCode.ERROR);
  const req = buildTimeStampReq(digest);
  let res: Response;
  try {
    res = await fetch(tsaUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/timestamp-query' },
      body: req,
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    throw new CliError(`could not reach TSA ${tsaUrl}: ${e instanceof Error ? e.message : String(e)}`, ExitCode.ERROR);
  }
  if (!res.ok) throw new CliError(`TSA ${tsaUrl} returned ${res.status}`, ExitCode.ERROR);
  const body = Buffer.from(await res.arrayBuffer());
  // Sanity-check the response contains a usable token bound to our digest.
  const v = verifyTimestamp(body, digest.toString('hex'));
  if (!v.imprintMatches) throw new CliError(`TSA response did not bind to our digest (${v.reason})`, ExitCode.ERROR);
  return body;
}
