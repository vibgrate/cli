import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runSecurityPacks } from './run-packs.js';
import type { HaileProvider } from '../engine/haile/haile-provider.js';

let root: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-run-packs-'));
  fs.mkdirSync(path.join(root, 'infra'));
  fs.writeFileSync(
    path.join(root, 'infra/s3.tf'),
    'resource "aws_s3_bucket" "logs" {\n  acl = "public-read"\n  master_password = "hunter2-sentinel"\n}\n',
  );
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** A fake module: records the document it received and answers with a canned result. */
function fakeProvider(answer: (document: unknown) => unknown): HaileProvider & { received: unknown[] } {
  const received: unknown[] = [];
  return {
    received,
    version: () => 'fake/1',
    classify: () => null,
    evalFacts(document) {
      received.push(document);
      return answer(document);
    },
  };
}

const ID = '0123456789abcdef0123456789abcdef';

describe('runSecurityPacks', () => {
  it('reports module-missing when no provider is available (never an empty section)', async () => {
    const run = await runSecurityPacks({ root, packs: ['iac-cis-v1'], provider: null });
    expect(run).toEqual({ status: 'module-missing' });
  });

  it('reports module-outdated when the installed module predates evalFacts', async () => {
    const old: HaileProvider = { version: () => 'old/1', classify: () => null };
    const run = await runSecurityPacks({ root, packs: ['iac-cis-v1'], provider: old });
    expect(run).toEqual({ status: 'module-outdated', version: 'old/1' });
  });

  it('hands the module a vg.facts.v1 document and returns the sanitised section', async () => {
    const provider = fakeProvider((document) => {
      const doc = document as { schema: string; packs: string[]; facts: Array<{ address: string; node: string; path: string; line: number }> };
      const fact = doc.facts[0];
      return {
        schema: 'vg.security.v1',
        engine: 'fake/1',
        packs: { 'iac-cis-v1': '1' },
        facts: { received: doc.facts.length, evaluated: doc.facts.length, rejected: 0 },
        findings: [
          {
            id: ID,
            pack: 'iac-cis-v1',
            packVersion: '1',
            rule: 'aws-s3-public',
            severity: 'high',
            message: `${fact.address} grants public access (acl public-read)`,
            path: fact.path,
            line: fact.line,
            address: fact.address,
            node: fact.node,
            owasp: ['A02:2025'],
            cwe: ['CWE-284'],
            cis: ['CIS-AWS-2.1.4'],
            // Off-contract extras the boundary must drop.
            rank: 99,
          },
          {
            id: 'not-hex',
            pack: 'iac-cis-v1',
            packVersion: '1',
            rule: 'x',
            severity: 'high',
            message: 'm',
            path: 'p',
          },
        ],
      };
    });
    const run = await runSecurityPacks({ root, packs: ['iac-cis-v1'], provider });
    expect(run.status).toBe('ok');
    if (run.status !== 'ok') return;

    // What the module received is the closed document — and it never saw the secret.
    expect(provider.received).toHaveLength(1);
    const document = provider.received[0] as { schema: string; packs: string[]; facts: unknown[] };
    expect(document.schema).toBe('vg.facts.v1');
    expect(document.packs).toEqual(['iac-cis-v1']);
    expect(document.facts).toHaveLength(1);
    expect(JSON.stringify(document)).not.toContain('hunter2-sentinel');

    expect(run.section.engine).toBe('fake/1');
    expect(run.section.packs).toEqual({ 'iac-cis-v1': '1' });
    expect(run.section.facts).toEqual({ received: 1, evaluated: 1, rejected: 0 });
    expect(run.section.findings).toHaveLength(1);
    expect(run.section.findings[0]).toMatchObject({
      id: ID,
      rule: 'aws-s3-public',
      path: 'infra/s3.tf',
      line: 1,
      address: 'aws_s3_bucket.logs',
    });
    expect(run.section.findings[0].node).toMatch(/^[0-9a-f]{32}$/);
    expect('rank' in run.section.findings[0]).toBe(false);
  });

  it('reports abstained when the module returns null', async () => {
    const run = await runSecurityPacks({ root, packs: ['iac-cis-v1'], provider: fakeProvider(() => null) });
    expect(run).toEqual({ status: 'abstained' });
  });

  it('reports abstained when the module throws', async () => {
    const provider = fakeProvider(() => {
      throw new Error('kernel trap');
    });
    const run = await runSecurityPacks({ root, packs: ['iac-cis-v1'], provider });
    expect(run).toEqual({ status: 'abstained' });
  });

  it('reports abstained when the result is off-contract at the top level', async () => {
    const provider = fakeProvider(() => ({ schema: 'vg.security.v1', engine: 'fake/1', packs: {}, findings: [] }));
    const run = await runSecurityPacks({ root, packs: ['iac-cis-v1'], provider });
    expect(run).toEqual({ status: 'abstained' });
  });

  it('keeps a valid result with zero findings as an ok section', async () => {
    const provider = fakeProvider(() => ({
      schema: 'vg.security.v1',
      engine: 'fake/1',
      packs: { 'iac-cis-v1': '1' },
      facts: { received: 1, evaluated: 1, rejected: 0 },
      findings: [],
    }));
    const run = await runSecurityPacks({ root, packs: ['iac-cis-v1'], provider });
    expect(run).toEqual({
      status: 'ok',
      section: {
        schema: 'vg.security.v1',
        engine: 'fake/1',
        packs: { 'iac-cis-v1': '1' },
        facts: { received: 1, evaluated: 1, rejected: 0 },
        findings: [],
      },
    });
  });
});
