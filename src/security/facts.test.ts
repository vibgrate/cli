import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { boundAttrs, buildFactDocument, factKindOf } from './facts.js';
import { nodeId } from '../engine/ids.js';
import type { Fact } from './types.js';

/** A small tree with one file of every wave-1 fact source. */
const TREE: Record<string, string> = {
  'infra/s3.tf': `resource "aws_s3_bucket" "logs" {
  bucket = "acme-logs"
  acl    = "public-read"
  tags   = { env = "prod" }
}
data "aws_ami" "ubuntu" { most_recent = true }
module "vpc" { source = "terraform-aws-modules/vpc/aws" version = "5.1.0" }
variable "region" { default = "eu-west-1" }
output "bucket" { value = aws_s3_bucket.logs.id }
`,
  'infra/versions.tf': `terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
}
`,
  'k8s/api.yaml': `apiVersion: apps/v1
kind: Deployment
metadata: { name: api, namespace: prod }
spec:
  template:
    spec:
      containers:
        - name: api
          image: ghcr.io/acme/api:1.2.3
          env: [{ name: DB_PASSWORD, value: plaintext-sentinel }]
---
apiVersion: v1
kind: Service
metadata: { name: api, namespace: prod }
spec: { type: ClusterIP, ports: [{ port: 80 }] }
`,
  'api/Dockerfile': `FROM node:22-alpine AS build
ENV NPM_TOKEN=npm-sentinel
FROM node:22-alpine
USER root
EXPOSE 8080
`,
  'charts/api/Chart.yaml': 'name: api\nversion: 1.4.0\ndependencies:\n  - name: redis\n    version: 17.x\n',
  'charts/api/values.yaml': 'image:\n  repository: ghcr.io/acme/api\n  tag: "1.2.3"\n',
  'docker-compose.yml': 'services:\n  api:\n    image: ghcr.io/acme/api:1.2.3\n',
  'README.md': '# not a fact\n',
};

let root: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-facts-'));
  for (const [rel, content] of Object.entries(TREE)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('factKindOf', () => {
  it('maps draft signatures to the closed kind set', () => {
    expect(factKindOf({ signature: 'terraform.resource', kind: 'resource' })).toBe('tf.resource');
    expect(factKindOf({ signature: 'terraform.data', kind: 'resource' })).toBe('tf.resource');
    expect(factKindOf({ signature: 'terraform.module', kind: 'module' })).toBe('tf.module');
    expect(factKindOf({ signature: 'terraform.provider', kind: 'package' })).toBe('tf.provider');
    expect(factKindOf({ signature: 'terraform.required_provider', kind: 'package' })).toBe('tf.provider');
    expect(factKindOf({ signature: 'k8s.Deployment', kind: 'workload' })).toBe('k8s.object');
    expect(factKindOf({ signature: 'k8s.ConfigMap', kind: 'resource' })).toBe('k8s.object');
    expect(factKindOf({ signature: 'dockerfile.stage', kind: 'image' })).toBe('docker.stage');
    expect(factKindOf({ signature: 'helm.chart', kind: 'chart' })).toBe('helm.chart');
  });

  it('is null for every draft that is not a fact source', () => {
    expect(factKindOf({ signature: 'k8s.image', kind: 'image' })).toBeNull();
    expect(factKindOf({ signature: 'terraform.variable', kind: 'property' })).toBeNull();
    expect(factKindOf({ signature: 'terraform.output', kind: 'property' })).toBeNull();
    expect(factKindOf({ signature: 'dockerfile', kind: 'image' })).toBeNull();
    expect(factKindOf({ signature: 'dockerfile.base', kind: 'image' })).toBeNull();
    expect(factKindOf({ signature: 'helm.dependency', kind: 'chart' })).toBeNull();
    expect(factKindOf({ signature: 'helm.values.image', kind: 'image' })).toBeNull();
    expect(factKindOf({ signature: 'compose.service', kind: 'resource' })).toBeNull();
    expect(factKindOf({ kind: 'resource' })).toBeNull();
  });
});

describe('buildFactDocument', () => {
  it('builds a closed, sorted vg.facts.v1 document over the tree', async () => {
    const doc = await buildFactDocument({ root, packs: ['iac-cis-v1'] });
    expect(Object.keys(doc)).toEqual(['schema', 'packs', 'facts']);
    expect(doc.schema).toBe('vg.facts.v1');
    expect(doc.packs).toEqual(['iac-cis-v1']);
    expect(doc.facts.map((f) => [f.kind, f.path, f.address])).toEqual([
      ['docker.stage', 'api/Dockerfile', 'dockerfile:api/Dockerfile#1'],
      ['docker.stage', 'api/Dockerfile', 'dockerfile:api/Dockerfile#build'],
      ['helm.chart', 'charts/api/Chart.yaml', 'chart:api'],
      ['k8s.object', 'k8s/api.yaml', 'prod/Deployment/api'],
      ['k8s.object', 'k8s/api.yaml', 'prod/Service/api'],
      ['tf.module', 'infra/s3.tf', 'module.vpc'],
      ['tf.provider', 'infra/versions.tf', 'provider.aws'],
      ['tf.resource', 'infra/s3.tf', 'aws_s3_bucket.logs'],
      ['tf.resource', 'infra/s3.tf', 'data.aws_ami.ubuntu'],
    ]);
    // Every fact carries exactly the contract's keys.
    for (const fact of doc.facts) {
      expect(Object.keys(fact).sort()).toEqual(['address', 'attrs', 'kind', 'line', 'node', 'path']);
      expect(fact.line).toBeGreaterThan(0);
      expect(fact.node).toMatch(/^[0-9a-f]{32}$/);
    }
  });

  it('binds each fact to the exact node id the graph gives the same draft', async () => {
    const doc = await buildFactDocument({ root, packs: ['iac-cis-v1'] });
    const byAddress = new Map(doc.facts.map((f) => [f.address, f]));
    expect(byAddress.get('aws_s3_bucket.logs')?.node).toBe(
      nodeId({ kind: 'resource', qualifiedName: 'aws_s3_bucket.logs', file: 'infra/s3.tf', signature: 'terraform.resource' }),
    );
    expect(byAddress.get('prod/Deployment/api')?.node).toBe(
      nodeId({ kind: 'workload', qualifiedName: 'prod/Deployment/api', file: 'k8s/api.yaml', signature: 'k8s.Deployment' }),
    );
    expect(byAddress.get('dockerfile:api/Dockerfile#build')?.node).toBe(
      nodeId({ kind: 'image', qualifiedName: 'dockerfile:api/Dockerfile#build', file: 'api/Dockerfile', signature: 'dockerfile.stage' }),
    );
    expect(byAddress.get('chart:api')?.node).toBe(
      nodeId({ kind: 'chart', qualifiedName: 'chart:api', file: 'charts/api/Chart.yaml', signature: 'helm.chart' }),
    );
  });

  it('carries the extractor projections and never a secret value', async () => {
    const doc = await buildFactDocument({ root, packs: ['iac-cis-v1'] });
    const byAddress = new Map(doc.facts.map((f) => [f.address, f]));
    expect(byAddress.get('aws_s3_bucket.logs')?.attrs).toEqual({
      type: 'aws_s3_bucket',
      name: 'logs',
      mode: 'managed',
      body: { bucket: 'acme-logs', acl: 'public-read', tags: { env: 'prod' } },
    });
    expect(byAddress.get('module.vpc')?.attrs).toEqual({ name: 'vpc', source: 'terraform-aws-modules/vpc/aws', version: '5.1.0' });
    expect(byAddress.get('provider.aws')?.attrs).toEqual({ name: 'aws', source: 'hashicorp/aws', version: '~> 5.0' });
    expect(byAddress.get('dockerfile:api/Dockerfile#1')?.attrs).toMatchObject({ final: true, user: ['root'], expose: ['8080'] });
    expect(byAddress.get('dockerfile:api/Dockerfile#build')?.attrs).toMatchObject({ final: false, env: [{ key: 'NPM_TOKEN', literal: true }] });
    const serialised = JSON.stringify(doc);
    expect(serialised).not.toContain('plaintext-sentinel');
    expect(serialised).not.toContain('npm-sentinel');
  });

  it('is deterministic and frozen', async () => {
    const a = await buildFactDocument({ root, packs: ['iac-cis-v1'] });
    const b = await buildFactDocument({ root, packs: ['iac-cis-v1'] });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(a.facts)).toBe(true);
  });

  it('honours excludes', async () => {
    const doc = await buildFactDocument({ root, exclude: ['k8s/**', 'charts/**'], packs: ['iac-cis-v1'] });
    expect(doc.facts.some((f) => f.kind === 'k8s.object')).toBe(false);
    expect(doc.facts.some((f) => f.kind === 'helm.chart')).toBe(false);
    expect(doc.facts.some((f) => f.kind === 'tf.resource')).toBe(true);
  });

  it('yields an empty fact list, not an error, for a tree with no toolchain files', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-facts-empty-'));
    try {
      fs.writeFileSync(path.join(empty, 'index.ts'), 'export {};\n');
      const doc = await buildFactDocument({ root: empty, packs: ['iac-cis-v1'] });
      expect(doc.facts).toEqual([]);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe('boundAttrs', () => {
  it('passes a well-formed projection through unchanged', () => {
    const attrs: Fact['attrs'] = { type: 'aws_s3_bucket', body: { acl: 'public-read', ingress: [{ from_port: 22 }], n: null, ok: true } };
    expect(boundAttrs(attrs)).toEqual(attrs);
  });

  it('caps strings, keys, items and depth', () => {
    const keys = Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`k${i}`, i]));
    const bounded = boundAttrs({
      long: 'x'.repeat(300),
      keys,
      items: Array.from({ length: 70 }, (_, i) => i),
      deep: { a: { b: { c: { d: { e: { f: { g: 1 } } } } } } },
      nan: Number.NaN,
      fn: () => 1,
      undef: undefined,
    }) as Record<string, unknown>;
    expect((bounded.long as string).length).toBe(256);
    expect(Object.keys(bounded.keys as object)).toHaveLength(64);
    expect(bounded.items).toHaveLength(64);
    expect(bounded.deep).toEqual({ a: { b: { c: { d: { e: {} } } } } });
    expect(bounded.nan).toBeNull();
    expect(bounded.fn).toBeNull();
    expect('undef' in bounded).toBe(false);
  });
});
