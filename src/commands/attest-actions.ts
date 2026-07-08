import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { loadGraph } from '../engine/load.js';
import { resolveHead, workingTreeDirty } from '../core-open/utils/git-history.js';
import {
  buildStatement,
  signStatement,
  verifyEnvelope,
  generateKeypair,
  serializeEnvelope,
  parseEnvelope,
  type CommitInfo,
  type VerifyResult,
} from '../engine/attest.js';
import { CliError, ExitCode } from '../util/exit.js';
import type { VgGraph } from '../schema.js';

/**
 * Attestation actions folded into the graph lifecycle: `vg build --attest` signs
 * the graph it just built; `vg build --verify` checks a committed attestation.
 * The crypto lives in engine/attest.ts; this is the file/key/git glue + output.
 */

const DEFAULT_ATTESTATION = 'attestation.intoto.jsonl';
const DEFAULT_KEY = 'attest-key.pem';

export interface SignOpts {
  /** Signing key PEM path; else $VG_ATTEST_KEY; else .vibgrate/attest-key.pem (auto-minted). */
  key?: string;
  /** Output path for the attestation (default .vibgrate/attestation.intoto.jsonl). */
  attestation?: string;
}

export interface SignSummary {
  keyid: string;
  graphDigest: string;
  fingerprint?: string;
  commit?: CommitInfo;
  out: string;
  keyGeneratedAt?: string;
}

/** Sign an already-built graph, writing a DSSE attestation. Returns a summary +
 *  human notices (the caller decides how to render them alongside build output). */
export async function signGraphAttestation(
  root: string,
  graph: VgGraph,
  opts: SignOpts,
): Promise<{ summary: SignSummary; notices: string[] }> {
  const notices: string[] = [];
  const explicitKey = opts.key ?? process.env.VG_ATTEST_KEY;
  const keyPath = explicitKey ? path.resolve(explicitKey) : path.join(root, '.vibgrate', DEFAULT_KEY);

  let keyGeneratedAt: string | undefined;
  if (!fs.existsSync(keyPath)) {
    if (explicitKey) {
      throw new CliError(`signing key not found: ${explicitKey}`, ExitCode.USAGE_ERROR);
    }
    // First use with no key: mint one at the default path (loud — it must be kept
    // and gitignored to re-sign reproducibly).
    const kp = generateKeypair();
    fs.mkdirSync(path.dirname(keyPath), { recursive: true });
    fs.writeFileSync(keyPath, kp.privatePem, { mode: 0o600 });
    fs.writeFileSync(`${keyPath}.pub`, kp.publicPem);
    keyGeneratedAt = keyPath;
    notices.push(
      `minted a new Ed25519 signing key at ${rel(root, keyPath)} (keyid ${kp.keyid}) — ` +
        `keep it, add it to .gitignore, and reuse it to re-sign reproducibly`,
    );
  }

  let privateKey: crypto.KeyObject;
  try {
    privateKey = crypto.createPrivateKey(fs.readFileSync(keyPath, 'utf8'));
  } catch {
    throw new CliError(`could not read an Ed25519 private key from ${rel(root, keyPath)}`, ExitCode.USAGE_ERROR);
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new CliError(
      `attest requires an Ed25519 key, but ${rel(root, keyPath)} is ${privateKey.asymmetricKeyType ?? 'unknown'}`,
      ExitCode.USAGE_ERROR,
    );
  }

  const commit = await gitCommitInfo(root);
  const statement = buildStatement(graph, { commit });
  const envelope = signStatement(statement, privateKey);
  const outPath = opts.attestation
    ? path.resolve(opts.attestation)
    : path.join(root, '.vibgrate', DEFAULT_ATTESTATION);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, serializeEnvelope(envelope));

  return {
    summary: {
      keyid: envelope.signatures[0]?.keyid ?? '',
      graphDigest: statement.predicate.graphDigest,
      fingerprint: statement.predicate.toolchain?.fingerprint,
      commit,
      out: rel(root, outPath),
      keyGeneratedAt: keyGeneratedAt ? rel(root, keyGeneratedAt) : undefined,
    },
    notices,
  };
}

export interface VerifyOpts {
  /** Attestation path (default .vibgrate/attestation.intoto.jsonl). */
  attestation?: string;
  /** Public key PEM to pin the signer (else integrity-only verification). */
  pub?: string;
}

export interface AttestVerifyOutcome {
  bundlePath: string;
  /** True when no attestation exists at the default path (and none was required). */
  missing: boolean;
  result?: VerifyResult;
}

/** Verify a committed attestation against the on-disk graph. Returns the outcome
 *  (the caller renders + decides the exit code). Throws only when an attestation
 *  was explicitly requested but is absent. */
export function verifyGraphAttestation(root: string, opts: VerifyOpts): AttestVerifyOutcome {
  const bundlePath = opts.attestation
    ? path.resolve(opts.attestation)
    : path.join(root, '.vibgrate', DEFAULT_ATTESTATION);
  if (!fs.existsSync(bundlePath)) {
    if (opts.attestation || opts.pub) {
      throw new CliError(
        `no attestation at ${rel(root, bundlePath)} — sign one with \`vg build --attest\``,
        ExitCode.NOT_FOUND,
      );
    }
    return { bundlePath, missing: true };
  }
  const envelope = parseEnvelope(fs.readFileSync(bundlePath, 'utf8'));
  const publicKeyPem = opts.pub ? fs.readFileSync(path.resolve(opts.pub), 'utf8') : undefined;
  const graph = loadGraph(root) ?? undefined;
  return { bundlePath, missing: false, result: verifyEnvelope(envelope, { publicKeyPem, graph }) };
}

async function gitCommitInfo(root: string): Promise<CommitInfo | undefined> {
  const sha = await resolveHead(root);
  if (!sha) return undefined;
  const dirty = await workingTreeDirty(root);
  const branch = await gitBranch(root);
  return { sha, shortSha: sha.slice(0, 7), branch, dirty: dirty === true ? true : dirty === false ? false : undefined };
}

/** Best-effort current branch name; undefined on detached HEAD or no git. */
function gitBranch(root: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      { cwd: root, timeout: 5000, windowsHide: true, encoding: 'utf8' },
      (err, stdout) => {
        if (err) return resolve(undefined);
        const name = String(stdout).trim();
        resolve(name && name !== 'HEAD' ? name : undefined);
      },
    );
  });
}

function rel(root: string, p: string): string {
  const r = path.relative(root, p);
  return r.startsWith('..') ? p : r;
}
