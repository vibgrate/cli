import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { extractToolchain, extractToolchainDrafts } from './index.js';
import { terraformExtractor } from './terraform.js';
import { kubernetesExtractor } from './kubernetes.js';
import { composeExtractor } from './compose.js';
import { dockerfileExtractor, logicalLines, copySourcePaths, parseLabels, parseEnvKeys, parseArgKeys } from './dockerfile.js';
import { githubActionsExtractor, imagesBuiltBy, terraformAppliedDirs } from './workflows.js';
import { helmExtractor } from './helm.js';
import { buildProjectProfile } from './profile.js';
import { LineIndex, parseImageRef, resolveRelative, safeDoc } from './util.js';
import type { DiscoveredDoc } from '../docs-ingest.js';

/** Write a throwaway repo and return `(rel → DiscoveredDoc)` for extraction. */
function fixture(files: Record<string, string>): { root: string; docs: DiscoveredDoc[] } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-toolchain-'));
  const docs: DiscoveredDoc[] = [];
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    docs.push({ rel, abs, kind: 'other-config', category: 'other-config' });
  }
  return { root, docs };
}

describe('util', () => {
  it('maps byte offsets to 1-based lines', () => {
    const index = new LineIndex('a\nbb\nccc\n');
    expect(index.lineAt(0)).toBe(1);
    expect(index.lineAt(2)).toBe(2);
    expect(index.lineAt(5)).toBe(3);
    expect(index.span(2, 5)).toEqual({ start: 2, end: 2 });
  });

  it('parses image references, including ports and digests', () => {
    expect(parseImageRef('nginx')).toMatchObject({ repository: 'nginx' });
    expect(parseImageRef('ghcr.io/acme/web:1.2.3')).toMatchObject({
      repository: 'ghcr.io/acme/web',
      tag: '1.2.3',
    });
    expect(parseImageRef('localhost:5000/img')).toMatchObject({
      repository: 'localhost:5000/img',
      tag: undefined,
    });
    expect(parseImageRef('repo@sha256:abc')).toMatchObject({
      repository: 'repo',
      digest: 'sha256:abc',
    });
  });

  it('refuses template expressions as image references', () => {
    expect(parseImageRef('${{ env.IMAGE }}')).toBeNull();
    expect(parseImageRef('{{ .Values.image }}')).toBeNull();
  });

  it('never resolves a path outside the repository root', () => {
    expect(resolveRelative('a/b/compose.yml', '../api/Dockerfile')).toBe('a/api/Dockerfile');
    expect(resolveRelative('compose.yml', '../../etc/passwd')).toBeNull();
  });

  it('redacts secrets in summaries (GUARDRAILS §1.1)', () => {
    // Assembled at runtime so this file never *contains* a string that reads as
    // a credential. A committed literal trips the repository's own gitleaks
    // gate, and allowlisting a rule to accommodate a test would weaken the scan
    // for a self-inflicted reason — the wrong trade in a tool that sells
    // supply-chain rigor.
    const fakeToken = ['ghp', '0123456789abcdefghijklmnopqrstuvwxyzA'].join('_');
    const doc = safeDoc(`token ${fakeToken}`);
    expect(doc).toBeDefined();
    expect(doc).not.toContain(fakeToken);
    // The surrounding text survives — redaction is targeted, not destructive.
    expect(doc).toContain('token');
  });
});

describe('terraform extractor', () => {
  it('extracts every provider from a nested required_providers block', async () => {
    const result = await terraformExtractor.extract(
      'infra/main.tf',
      `terraform {
  required_providers {
    aws     = { source = "hashicorp/aws", version = "~> 5.0" }
    azurerm = { source = "hashicorp/azurerm" }
  }
}`,
    );
    const providers = result.nodes.filter((n) => n.signature === 'terraform.required_provider');
    expect(providers.map((p) => p.qualifiedName)).toEqual(['provider.aws', 'provider.azurerm']);
  });

  it('records the legacy version-only provider shorthand with its implied source', async () => {
    const result = await terraformExtractor.extract(
      'infra/main.tf',
      `terraform {
  required_providers {
    aws     = "~> 2.0"
    google  = { source = "hashicorp/google", version = "5.0" }
  }
}`,
    );
    const providers = result.nodes.filter((n) => n.signature === 'terraform.required_provider');
    expect(providers.map((p) => [p.qualifiedName, p.doc])).toEqual([
      ['provider.aws', 'source hashicorp/aws, version ~> 2.0'],
      ['provider.google', 'source hashicorp/google, version 5.0'],
    ]);
  });

  it('builds dependency edges from interpolation references', async () => {
    const result = await terraformExtractor.extract(
      'infra/main.tf',
      `resource "aws_vpc" "main" { cidr_block = "10.0.0.0/16" }
resource "aws_subnet" "a" { vpc_id = aws_vpc.main.id }`,
    );
    expect(result.edges).toEqual([
      { kind: 'depends_on', from: 'aws_subnet.a', to: 'aws_vpc.main', confidence: 1 },
    ]);
  });

  it('finds references nested inside sub-blocks', async () => {
    const result = await terraformExtractor.extract(
      'infra/main.tf',
      `resource "aws_vpc" "main" {}
resource "aws_instance" "web" {
  lifecycle { ignore_changes = [aws_vpc.main] }
}`,
    );
    expect(result.edges.map((e) => e.to)).toContain('aws_vpc.main');
  });

  it('drops references to declarations in other files', async () => {
    const result = await terraformExtractor.extract(
      'infra/main.tf',
      `resource "aws_instance" "web" { subnet_id = aws_subnet.elsewhere.id }`,
    );
    // The target is not declared here, so no dangling edge is invented.
    expect(result.edges).toEqual([]);
  });

  it('ignores loop and context builtins', async () => {
    const result = await terraformExtractor.extract(
      'infra/main.tf',
      `resource "aws_instance" "web" {
  name = each.key
  root = path.module
}`,
    );
    expect(result.edges).toEqual([]);
  });

  it('recovers from a syntax error with a warning rather than throwing', async () => {
    const result = await terraformExtractor.extract('infra/broken.tf', 'resource "a" "b" {');
    expect(result.warnings?.join(' ')).toMatch(/syntax error|no tree/);
  });

  describe('attrs projection (facts.md §2.2)', () => {
    const source = `resource "aws_security_group" "web" {
  name        = "web"
  from_port   = 22
  protocol    = -1
  enabled     = true
  nothing     = null
  cidr_blocks = ["0.0.0.0/0", "10.0.0.0/8"]
  tags        = { env = "prod", "quoted key" = 1, db_password = "tag-secret-sentinel" }
  vpc_id      = aws_vpc.main.id
  description = "\${var.prefix}-web"
  count_text  = lower("A")
  choice      = var.a ? 1 : 2
  paren       = (443)
  escaped     = "say \\"hi\\""
  master_password = "hunter2-sentinel"
  ingress {
    from_port   = 22
    cidr_blocks = ["0.0.0.0/0"]
  }
  ingress {
    from_port = 80
  }
  dynamic "egress" {
    for_each = var.rules
    content { from_port = 1 }
  }
  root_block_device { encrypted = false }
}
`;

    async function bodyOf(src: string, address = 'aws_security_group.web') {
      const result = await terraformExtractor.extract('infra/main.tf', src);
      const node = result.nodes.find((n) => n.qualifiedName === address);
      return { node, attrs: node?.attrs as Record<string, unknown> | undefined, result };
    }

    it('projects literals, tuples and objects as JSON values', async () => {
      const { attrs } = await bodyOf(source);
      expect(attrs).toMatchObject({ type: 'aws_security_group', name: 'web', mode: 'managed' });
      const body = attrs?.body as Record<string, unknown>;
      expect(body.name).toBe('web');
      expect(body.from_port).toBe(22);
      expect(body.protocol).toBe(-1);
      expect(body.enabled).toBe(true);
      expect(body.nothing).toBeNull();
      expect(body.cidr_blocks).toEqual(['0.0.0.0/0', '10.0.0.0/8']);
      expect(body.tags).toEqual({ env: 'prod', 'quoted key': 1, db_password: { redacted: true } });
      expect(body.paren).toBe(443);
      expect(body.escaped).toBe('say "hi"');
    });

    it('turns every non-literal expression into { expr }', async () => {
      const { attrs } = await bodyOf(source);
      const body = attrs?.body as Record<string, unknown>;
      expect(body.vpc_id).toEqual({ expr: 'aws_vpc.main.id' });
      // A quoted template with an interpolation is an expression, not a string.
      expect(body.description).toEqual({ expr: '"${var.prefix}-web"' });
      expect(body.count_text).toEqual({ expr: 'lower("A")' });
      expect(body.choice).toEqual({ expr: 'var.a ? 1 : 2' });
    });

    it('groups nested blocks by type in source order and records dynamic blocks', async () => {
      const { attrs } = await bodyOf(source);
      const body = attrs?.body as Record<string, unknown>;
      expect(body.ingress).toEqual([
        { from_port: 22, cidr_blocks: ['0.0.0.0/0'] },
        { from_port: 80 },
      ]);
      expect(body.egress).toEqual([{ dynamic: 'egress' }]);
      expect(body.root_block_device).toEqual([{ encrypted: false }]);
    });

    it('redacts secret-shaped keys and never carries the value (GUARDRAILS §1.1)', async () => {
      const { attrs } = await bodyOf(source);
      const body = attrs?.body as Record<string, unknown>;
      expect(body.master_password).toEqual({ redacted: true });
      const serialised = JSON.stringify(attrs);
      expect(serialised).not.toContain('hunter2-sentinel');
      expect(serialised).not.toContain('tag-secret-sentinel');
    });

    it('marks data sources as mode data and addresses them under data.', async () => {
      const { attrs } = await bodyOf('data "aws_ami" "ubuntu" { most_recent = true }', 'data.aws_ami.ubuntu');
      expect(attrs).toEqual({ type: 'aws_ami', name: 'ubuntu', mode: 'data', body: { most_recent: true } });
    });

    it('projects module and provider coordinates only when literal', async () => {
      const src = `module "vpc" { source = "terraform-aws-modules/vpc/aws" version = "5.1.0" }
module "dyn" { source = var.src }
provider "aws" { region = "eu-west-1" }
terraform { required_providers { aws = { source = "hashicorp/aws", version = "~> 5.0" } } }
variable "x" { default = 1 }
`;
      const result = await terraformExtractor.extract('infra/main.tf', src);
      const byName = new Map(result.nodes.map((n) => [n.qualifiedName, n.attrs]));
      expect(byName.get('module.vpc')).toEqual({ name: 'vpc', source: 'terraform-aws-modules/vpc/aws', version: '5.1.0' });
      expect(byName.get('module.dyn')).toEqual({ name: 'dyn' });
      // First declaration of an address wins (the graph's rule): here the
      // `provider "aws"` block precedes `required_providers`, so its projection
      // — name only, no source — is the one that lands.
      expect(byName.get('provider.aws')).toEqual({ name: 'aws' });
      expect(byName.get('var.x')).toBeUndefined();

      // With `required_providers` first, the declared coordinates land.
      const declaredFirst = await terraformExtractor.extract(
        'infra/versions.tf',
        'terraform { required_providers { aws = { source = "hashicorp/aws", version = "~> 5.0" } } }\nprovider "aws" {}\n',
      );
      expect(declaredFirst.nodes.find((n) => n.qualifiedName === 'provider.aws')?.attrs).toEqual({
        name: 'aws',
        source: 'hashicorp/aws',
        version: '~> 5.0',
      });
    });

    it('caps depth, keys, items and string length', async () => {
      const keys = Array.from({ length: 70 }, (_, i) => `k${i} = ${i}`).join('\n');
      const items = Array.from({ length: 70 }, (_, i) => String(i)).join(', ');
      // Hyphenated so it reads as prose, not as the 40+ char blob redaction scrubs.
      const long = 'ab-'.repeat(100);
      const deep = 'a { b { c { d { e { f { g { h = 1 } } } } } } }';
      const { attrs } = await bodyOf(`resource "aws_security_group" "web" {\n${keys}\nlist = [${items}]\nlong = "${long}"\n${deep}\n}`);
      const body = attrs?.body as Record<string, unknown>;
      expect(Object.keys(body)).toHaveLength(64);
      expect(body.list).toBeUndefined(); // the 65th key never lands
      const { attrs: capped } = await bodyOf(`resource "aws_security_group" "web" {\nlist = [${items}]\nlong = "${long}"\n${deep}\n}`);
      const cappedBody = capped?.body as Record<string, unknown>;
      expect(cappedBody.list).toHaveLength(64);
      expect((cappedBody.long as string).length).toBe(256);
      // Depth: body(1) → a[](2) → {}(3) → b[](4) → {}(5) → c[](6) → {}(7) is over the cap, so `c` is dropped.
      expect(cappedBody.a).toEqual([{ b: [{}] }]);
    });

    it('is deterministic: same bytes, same projection', async () => {
      const a = await terraformExtractor.extract('infra/main.tf', source);
      const b = await terraformExtractor.extract('infra/main.tf', source);
      expect(JSON.stringify(a.nodes.map((n) => n.attrs))).toBe(JSON.stringify(b.nodes.map((n) => n.attrs)));
    });
  });
});

describe('kubernetes extractor', () => {
  const manifest = `apiVersion: apps/v1
kind: Deployment
metadata: { name: web, namespace: prod }
spec:
  replicas: 2
  template:
    metadata: { labels: { app: web, tier: api } }
    spec:
      containers:
        - name: app
          image: ghcr.io/acme/web:1.2.3
          envFrom: [{ secretRef: { name: web-secrets } }]
---
apiVersion: v1
kind: Service
metadata: { name: web-svc, namespace: prod }
spec:
  selector: { app: web }
  ports: [{ port: 80 }]
`;

  it('extracts every document in a multi-document stream', async () => {
    const result = await kubernetesExtractor.extract('k8s/web.yaml', manifest);
    expect(result.nodes.map((n) => n.qualifiedName)).toEqual(
      expect.arrayContaining(['prod/Deployment/web', 'prod/Service/web-svc']),
    );
  });

  it('classifies a Deployment as a workload and a Service as a resource', async () => {
    const result = await kubernetesExtractor.extract('k8s/web.yaml', manifest);
    const byName = new Map(result.nodes.map((n) => [n.qualifiedName, n]));
    expect(byName.get('prod/Deployment/web')?.kind).toBe('workload');
    expect(byName.get('prod/Service/web-svc')?.kind).toBe('resource');
  });

  it('links a Service to a workload whose labels its selector matches', async () => {
    const result = await kubernetesExtractor.extract('k8s/web.yaml', manifest);
    expect(result.edges).toContainEqual({
      kind: 'exposes',
      from: 'prod/Service/web-svc',
      to: 'prod/Deployment/web',
      confidence: 1,
    });
  });

  it('records a secret by name and never by value', async () => {
    const result = await kubernetesExtractor.extract('k8s/web.yaml', manifest);
    expect(result.edges).toContainEqual({
      kind: 'mounts',
      from: 'prod/Deployment/web',
      to: 'Secret/web-secrets',
      confidence: 1,
    });
  });

  it('declines Helm templates', () => {
    expect(
      kubernetesExtractor.matches('charts/x/templates/dep.yaml', 'infra', '{{- if .Values.on }}'),
    ).toBe(false);
  });

  it('does not emit a node for a templated image reference', async () => {
    const result = await kubernetesExtractor.extract(
      'k8s/t.yaml',
      `apiVersion: apps/v1
kind: Deployment
metadata: { name: w }
spec:
  template:
    spec:
      containers: [{ name: c, image: "\${IMAGE}" }]
`,
    );
    expect(result.nodes.filter((n) => n.kind === 'image')).toEqual([]);
  });

  it('survives malformed YAML with a warning', async () => {
    const result = await kubernetesExtractor.extract('k8s/bad.yaml', 'apiVersion: v1\nkind: [unclosed');
    expect(result.nodes).toEqual([]);
    expect(result.warnings?.length).toBeGreaterThan(0);
  });

  describe('attrs projection (facts.md §2.2)', () => {
    const workload = `apiVersion: apps/v1
kind: Deployment
metadata: { name: api }
spec:
  template:
    spec:
      hostNetwork: true
      securityContext: { runAsNonRoot: true, runAsUser: 1000 }
      serviceAccountName: api
      automountServiceAccountToken: false
      initContainers:
        - name: init
          image: busybox
      containers:
        - name: api
          image: ghcr.io/acme/api:1.2.3
          securityContext: { privileged: true, runAsUser: 0, allowPrivilegeEscalation: true, readOnlyRootFilesystem: false, capabilities: { add: [NET_ADMIN], drop: [ALL] } }
          resources: { limits: { cpu: 500m, memory: 256Mi }, requests: { cpu: 100m } }
          env:
            - { name: DB_PASSWORD, value: plaintext-sentinel-value }
            - { name: EMPTY, value: "" }
            - { name: TOKEN, valueFrom: { secretKeyRef: { name: s, key: t } } }
            - { name: CM, valueFrom: { configMapKeyRef: { name: c, key: k } } }
            - { name: POD, valueFrom: { fieldRef: { fieldPath: metadata.name } } }
            - { name: BARE }
          ports: [{ containerPort: 8080 }, { containerPort: 9090 }]
`;

    it('projects the workload spec: host namespaces, security contexts, resources, env sources, ports', async () => {
      const result = await kubernetesExtractor.extract('k8s/api.yaml', workload);
      const attrs = result.nodes.find((n) => n.qualifiedName === 'default/Deployment/api')?.attrs;
      expect(attrs).toEqual({
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        name: 'api',
        namespace: 'default',
        spec: {
          hostNetwork: true,
          securityContext: { runAsNonRoot: true, runAsUser: 1000 },
          serviceAccountName: 'api',
          automountServiceAccountToken: false,
          containers: [
            { name: 'init', image: 'busybox', kind: 'initContainer' },
            {
              name: 'api',
              image: 'ghcr.io/acme/api:1.2.3',
              kind: 'container',
              securityContext: {
                privileged: true,
                runAsUser: 0,
                allowPrivilegeEscalation: true,
                readOnlyRootFilesystem: false,
                capabilities: { add: ['NET_ADMIN'], drop: ['ALL'] },
              },
              resources: { limits: { cpu: '500m', memory: '256Mi' }, requests: { cpu: '100m' } },
              env: [
                { name: 'DB_PASSWORD', literal: true },
                { name: 'EMPTY', literal: true },
                { name: 'TOKEN', fromSecret: true },
                { name: 'CM', fromConfigMap: true },
                { name: 'POD', fromField: true },
                { name: 'BARE' },
              ],
              ports: [8080, 9090],
            },
          ],
        },
      });
    });

    it('never projects an environment value (GUARDRAILS §1.1)', async () => {
      const result = await kubernetesExtractor.extract('k8s/api.yaml', workload);
      const attrs = result.nodes.find((n) => n.qualifiedName === 'default/Deployment/api')?.attrs;
      expect(JSON.stringify(attrs)).not.toContain('plaintext-sentinel-value');
    });

    it('leaves undeclared keys absent rather than defaulting them', async () => {
      const result = await kubernetesExtractor.extract(
        'k8s/min.yaml',
        'apiVersion: v1\nkind: Pod\nmetadata: { name: p, namespace: prod }\nspec:\n  containers: [{ name: c, image: nginx }]\n',
      );
      const attrs = result.nodes.find((n) => n.qualifiedName === 'prod/Pod/p')?.attrs;
      expect(attrs).toEqual({
        apiVersion: 'v1',
        kind: 'Pod',
        name: 'p',
        namespace: 'prod',
        spec: { containers: [{ name: 'c', image: 'nginx', kind: 'container' }] },
      });
    });

    it('projects RBAC rules and bindings, Service type and ports, and {} for other kinds', async () => {
      const result = await kubernetesExtractor.extract(
        'k8s/rbac.yaml',
        `apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata: { name: admin }
rules:
  - { apiGroups: ["*"], resources: ["*"], verbs: ["*"] }
  - { nonResourceURLs: ["/healthz"], verbs: [get] }
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata: { name: b, namespace: prod }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: cluster-admin }
subjects: [{ kind: ServiceAccount, name: default, namespace: prod }]
---
apiVersion: v1
kind: Service
metadata: { name: svc }
spec: { type: LoadBalancer, ports: [{ port: 80 }, { port: 443, targetPort: 8443 }] }
---
apiVersion: v1
kind: ConfigMap
metadata: { name: cm }
data: { key: value }
`,
      );
      const byName = new Map(result.nodes.map((n) => [n.qualifiedName, n.attrs]));
      expect(byName.get('default/ClusterRole/admin')?.spec).toEqual({
        rules: [
          { apiGroups: ['*'], resources: ['*'], verbs: ['*'] },
          { nonResourceURLs: ['/healthz'], verbs: ['get'] },
        ],
      });
      expect(byName.get('prod/RoleBinding/b')?.spec).toEqual({
        roleRef: { kind: 'ClusterRole', name: 'cluster-admin' },
        subjects: [{ kind: 'ServiceAccount', name: 'default', namespace: 'prod' }],
      });
      expect(byName.get('default/Service/svc')?.spec).toEqual({ type: 'LoadBalancer', ports: [80, 443] });
      expect(byName.get('default/ConfigMap/cm')?.spec).toEqual({});
      // Image nodes are not facts and carry no projection.
      expect(result.nodes.filter((n) => n.kind === 'image').every((n) => n.attrs === undefined)).toBe(true);
    });
  });
});

describe('compose extractor', () => {
  const compose = `services:
  api:
    build: { context: ./api, dockerfile: Dockerfile }
    ports: ["8080:8080"]
    depends_on:
      db: { condition: service_healthy }
  db:
    image: postgres:16-alpine
`;

  it('extracts services and resolves the build path', async () => {
    const result = await composeExtractor.extract('docker-compose.yml', compose);
    expect(result.nodes.map((n) => n.qualifiedName)).toEqual(
      expect.arrayContaining(['service:api', 'service:db', 'dockerfile:api/Dockerfile']),
    );
  });

  it('reads depends_on in the long map form', async () => {
    const result = await composeExtractor.extract('docker-compose.yml', compose);
    expect(result.edges).toContainEqual({
      kind: 'depends_on',
      from: 'service:api',
      to: 'service:db',
      confidence: 1,
    });
  });

  it('reads the build shorthand', async () => {
    const result = await composeExtractor.extract(
      'docker-compose.yml',
      'services:\n  api:\n    build: ./api\n',
    );
    expect(result.nodes.map((n) => n.qualifiedName)).toContain('dockerfile:api/Dockerfile');
  });
});

describe('dockerfile extractor', () => {
  const dockerfile = `# syntax=docker/dockerfile:1
FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json ./
RUN npm ci \\
 && npm run build
FROM node:22-alpine
COPY --from=builder /app/dist /app/dist
EXPOSE 8080
`;

  it('folds line continuations into one instruction', () => {
    const lines = logicalLines(dockerfile);
    const run = lines.find((l) => l.instruction === 'RUN');
    expect(run?.args).toBe('npm ci && npm run build');
  });

  it('honours a # escape= directive', () => {
    const lines = logicalLines('# escape=`\nRUN a `\n b\n');
    expect(lines[0].args).toBe('a b');
  });

  it('names stages and links COPY --from between them', async () => {
    const result = await dockerfileExtractor.extract('api/Dockerfile', dockerfile);
    const names = result.nodes.map((n) => n.qualifiedName);
    expect(names).toContain('dockerfile:api/Dockerfile#builder');
    expect(names).toContain('dockerfile:api/Dockerfile#1');
    expect(result.edges).toContainEqual({
      kind: 'depends_on',
      from: 'dockerfile:api/Dockerfile#1',
      to: 'dockerfile:api/Dockerfile#builder',
      confidence: 1,
    });
  });

  it('scopes copy sources to the stage that reads them', async () => {
    const result = await dockerfileExtractor.extract('api/Dockerfile', dockerfile);
    const byStage = result.linkHints?.copySourcesByStage ?? {};
    expect(byStage['dockerfile:api/Dockerfile#builder']).toContain('api/package.json');
    // The final stage only copies from `builder`, so it reads nothing from the repo.
    expect(byStage['dockerfile:api/Dockerfile#1']).toBeUndefined();
  });

  it('drops globs, URLs and build-arg expansions from copy sources', () => {
    expect(copySourcePaths('*.json ./', false)).toEqual([]);
    expect(copySourcePaths('https://example.com/x ./', false)).toEqual([]);
    expect(copySourcePaths('$SRC ./', false)).toEqual([]);
    expect(copySourcePaths('a.txt b.txt ./', false)).toEqual(['a.txt', 'b.txt']);
  });

  it('skips a FROM whose image is a build-arg indirection', async () => {
    const result = await dockerfileExtractor.extract('Dockerfile', 'FROM $BASE\n');
    expect(result.nodes.filter((n) => n.signature === 'dockerfile.base')).toEqual([]);
  });

  it('parses LABEL in both modern and legacy forms', () => {
    expect(parseLabels('a=1 b="two words" c=\'three\' d=')).toEqual([
      { key: 'a', value: '1' },
      { key: 'b', value: 'two words' },
      { key: 'c', value: 'three' },
      { key: 'd', value: '' },
    ]);
    expect(parseLabels('"com.example.key with space"="v=1" e="say \\"hi\\""')).toEqual([
      { key: 'com.example.key with space', value: 'v=1' },
      { key: 'e', value: 'say "hi"' },
    ]);
    expect(parseLabels('maintainer Jane Doe <jane@example.com>')).toEqual([{ key: 'maintainer', value: 'Jane Doe <jane@example.com>' }]);
    expect(parseLabels('')).toEqual([]);
  });

  it('records OCI image labels as property nodes on the stage that declares them', async () => {
    const source = `FROM node:22-alpine AS builder
LABEL stage=builder
FROM node:22-alpine
ARG GIT_SHA
LABEL org.opencontainers.image.source="https://github.com/acme/web" \\
      org.opencontainers.image.revision=$GIT_SHA \\
      org.opencontainers.image.licenses=Apache-2.0
LABEL org.opencontainers.image.title="Acme Web"
`;
    const result = await dockerfileExtractor.extract('Dockerfile', source);
    const labels = result.nodes.filter((n) => n.signature === 'dockerfile.label');
    expect(labels.map((n) => n.qualifiedName)).toEqual([
      'dockerfile:Dockerfile#builder/label/stage',
      'dockerfile:Dockerfile#1/label/org.opencontainers.image.source',
      'dockerfile:Dockerfile#1/label/org.opencontainers.image.revision',
      'dockerfile:Dockerfile#1/label/org.opencontainers.image.licenses',
      'dockerfile:Dockerfile#1/label/org.opencontainers.image.title',
    ]);
    const source_ = labels.find((n) => n.name === 'org.opencontainers.image.source');
    expect(source_).toMatchObject({ kind: 'property', doc: 'org.opencontainers.image.source=https://github.com/acme/web', span: { start: 5, end: 7 } });
    // An unresolved build arg is kept as written — the file does not know its value.
    expect(labels.find((n) => n.name === 'org.opencontainers.image.revision')?.doc).toBe('org.opencontainers.image.revision=$GIT_SHA');
    expect(result.edges).toContainEqual({ kind: 'contains', from: 'dockerfile:Dockerfile#1', to: 'dockerfile:Dockerfile#1/label/org.opencontainers.image.title', confidence: 1 });
    // Same bytes, same output.
    expect(await dockerfileExtractor.extract('Dockerfile', source)).toEqual(result);
  });

  describe('attrs projection (facts.md §2.2)', () => {
    const source = `ARG BASE=node:22
FROM node:22-alpine AS build
ARG NPM_TOKEN=npm-token-sentinel
ARG PLAIN
ENV NODE_ENV=production API_TOKEN="api-token-sentinel" HOME=
ENV LEGACY some value with spaces
ENV EXPANDED=$HOME/bin
USER root:root
HEALTHCHECK NONE
FROM build AS runtime
USER node
EXPOSE 8080 9229/tcp
HEALTHCHECK --interval=30s CMD curl -f http://localhost/ || exit 1
FROM $BASE
`;

    it('projects each stage with from, user, env keys, arg keys, expose and healthcheck', async () => {
      const result = await dockerfileExtractor.extract('api/Dockerfile', source);
      const byName = new Map(result.nodes.map((n) => [n.qualifiedName, n.attrs]));
      expect(byName.get('api/Dockerfile')).toBeUndefined();
      expect(byName.get('dockerfile:api/Dockerfile')).toBeUndefined();
      expect(byName.get('dockerfile:api/Dockerfile#build')).toEqual({
        file: 'api/Dockerfile',
        stage: 'build',
        index: 0,
        final: false,
        from: 'node:22-alpine',
        user: ['root'],
        env: [
          { key: 'NODE_ENV', literal: true },
          { key: 'API_TOKEN', literal: true },
          { key: 'HOME', literal: false },
          { key: 'LEGACY', literal: true },
          { key: 'EXPANDED', literal: false },
        ],
        arg: [
          { key: 'NPM_TOKEN', hasDefault: true },
          { key: 'PLAIN', hasDefault: false },
        ],
        expose: [],
        healthcheck: false,
      });
      expect(byName.get('dockerfile:api/Dockerfile#runtime')).toEqual({
        file: 'api/Dockerfile',
        stage: 'runtime',
        index: 1,
        final: false,
        from: { stage: 'build' },
        user: ['node'],
        env: [],
        arg: [],
        expose: ['8080', '9229/tcp'],
        healthcheck: true,
      });
      // Only the last FROM is final; a build-arg base image is an expression.
      expect(byName.get('dockerfile:api/Dockerfile#2')).toEqual({
        file: 'api/Dockerfile',
        stage: '2',
        index: 2,
        final: true,
        from: { expr: '$BASE' },
        user: [],
        env: [],
        arg: [],
        expose: [],
        healthcheck: false,
      });
    });

    it('never projects an ENV or ARG value (GUARDRAILS §1.1)', async () => {
      const result = await dockerfileExtractor.extract('api/Dockerfile', source);
      const serialised = JSON.stringify(result.nodes.map((n) => n.attrs));
      expect(serialised).not.toContain('api-token-sentinel');
      expect(serialised).not.toContain('npm-token-sentinel');
      expect(serialised).not.toContain('production');
    });

    it('parses ENV in both forms and ARG with or without a default', () => {
      expect(parseEnvKeys('A=1 B="two words" C= D=$X')).toEqual([
        { key: 'A', literal: true },
        { key: 'B', literal: true },
        { key: 'C', literal: false },
        { key: 'D', literal: false },
      ]);
      expect(parseEnvKeys('LEGACY a b c')).toEqual([{ key: 'LEGACY', literal: true }]);
      expect(parseArgKeys('A=1 B')).toEqual([
        { key: 'A', hasDefault: true },
        { key: 'B', hasDefault: false },
      ]);
    });

    it('marks the single stage of a one-FROM file as final', async () => {
      const result = await dockerfileExtractor.extract('Dockerfile', 'FROM nginx\nUSER 0:0\n');
      const stage = result.nodes.find((n) => n.signature === 'dockerfile.stage')?.attrs;
      expect(stage).toMatchObject({ stage: '0', index: 0, final: true, from: 'nginx', user: ['0'] });
    });
  });
});

describe('github actions extractor', () => {
  const workflow = `name: CD
on: [push, workflow_dispatch]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: docker build -t ghcr.io/acme/web:1.2.3 ./api
        env: { TOKEN: "\${{ secrets.GHCR_TOKEN }}" }
  deploy:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - run: terraform -chdir=infra apply -auto-approve
`;

  it('extracts jobs, steps and needs edges', async () => {
    const result = await githubActionsExtractor.extract('.github/workflows/cd.yml', workflow);
    expect(result.edges).toContainEqual({
      kind: 'depends_on',
      from: 'job:deploy',
      to: 'job:build',
      confidence: 1,
    });
  });

  it('turns triggers into edges from an event node', async () => {
    const result = await githubActionsExtractor.extract('.github/workflows/cd.yml', workflow);
    const triggers = result.edges.filter((e) => e.kind === 'triggers').map((e) => e.from);
    expect(triggers).toEqual(expect.arrayContaining(['event:push', 'event:workflow_dispatch']));
  });

  it('records a secret reference by name, never its value', async () => {
    const result = await githubActionsExtractor.extract('.github/workflows/cd.yml', workflow);
    expect(result.nodes.map((n) => n.qualifiedName)).toContain('secret:GHCR_TOKEN');
    expect(JSON.stringify(result)).not.toContain('${{ secrets.GHCR_TOKEN }}');
  });

  it('mines built images and terraform directories out of run scripts', () => {
    expect(imagesBuiltBy('docker build -t ghcr.io/acme/web:1.2.3 .')).toEqual([
      'ghcr.io/acme/web:1.2.3',
    ]);
    expect(imagesBuiltBy('docker buildx build --tag a/b:1 .')).toEqual(['a/b:1']);
    expect(imagesBuiltBy('docker build -t ${TAG} .')).toEqual([]);
    expect(terraformAppliedDirs('terraform -chdir=infra apply')).toEqual(['infra']);
    expect(terraformAppliedDirs('terraform apply', 'envs/prod')).toEqual(['envs/prod']);
  });

  it('resolves a terraform directory against the workspace root, not the workflow file', async () => {
    const result = await githubActionsExtractor.extract('.github/workflows/cd.yml', workflow);
    expect(result.nodes.map((n) => n.qualifiedName)).toContain('tfdir:infra');
  });
});

describe('helm extractor', () => {
  it('extracts a chart and its declared dependencies', async () => {
    const result = await helmExtractor.extract(
      'charts/web/Chart.yaml',
      'name: web\nversion: 0.4.2\ndependencies:\n  - name: redis\n    version: "18.0.0"\n',
    );
    expect(result.nodes.map((n) => n.qualifiedName)).toEqual(['chart:web', 'chart:redis']);
    expect(result.edges).toContainEqual({
      kind: 'depends_on',
      from: 'chart:web',
      to: 'chart:redis',
      confidence: 1,
    });
  });

  it('reads images out of a chart values file', async () => {
    const result = await helmExtractor.extract(
      'charts/web/values.yaml',
      'image:\n  repository: ghcr.io/acme/web\n  tag: "1.2.3"\n',
    );
    expect(result.nodes.map((n) => n.qualifiedName)).toContain('image:ghcr.io/acme/web:1.2.3');
  });

  it('does not claim a bare values.yaml outside a chart', () => {
    expect(helmExtractor.matches('config/values.yaml', 'other-config', '')).toBe(false);
  });

  it('projects the chart identity and dependency coordinates as attrs (facts.md §2.2)', async () => {
    const result = await helmExtractor.extract(
      'charts/api/Chart.yaml',
      'name: api\nversion: 1.4.0\nappVersion: "2.0.1"\ndependencies:\n  - name: redis\n    version: 17.x\n    repository: https://charts.bitnami.com/bitnami\n  - name: bare\n',
    );
    const chart = result.nodes.find((n) => n.qualifiedName === 'chart:api');
    expect(chart?.attrs).toEqual({
      name: 'api',
      version: '1.4.0',
      appVersion: '2.0.1',
      dependencies: [
        { name: 'redis', version: '17.x', repository: 'https://charts.bitnami.com/bitnami' },
        { name: 'bare' },
      ],
    });
    // Dependency nodes and values images carry no projection of their own.
    expect(result.nodes.find((n) => n.qualifiedName === 'chart:redis')?.attrs).toBeUndefined();
    const minimal = await helmExtractor.extract('charts/x/Chart.yaml', 'name: x\n');
    expect(minimal.nodes[0]?.attrs).toEqual({ name: 'x', dependencies: [] });
  });
});

describe('extractToolchain', () => {
  const files = {
    'infra/main.tf': 'resource "aws_eks_cluster" "main" { name = "prod" }\n',
    'api/Dockerfile': 'FROM node:22-alpine AS builder\nCOPY api/package.json ./\n',
    'docker-compose.yml': 'services:\n  api:\n    build: { context: ./api }\n',
    'k8s/web.yaml':
      'apiVersion: apps/v1\nkind: Deployment\nmetadata: { name: web }\nspec:\n  template:\n    spec:\n      containers: [{ name: c, image: ghcr.io/acme/web:1.2.3 }]\n',
    '.github/workflows/cd.yml':
      'name: CD\non: push\njobs:\n  build:\n    steps:\n      - run: docker build -t ghcr.io/acme/web:1.2.3 ./api\n  infra:\n    steps:\n      - run: terraform -chdir=infra apply\n',
  };

  it('is deterministic across runs', async () => {
    const { docs } = fixture(files);
    const a = await extractToolchain(docs);
    const b = await extractToolchain(docs);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('is independent of discovery order', async () => {
    const { docs } = fixture(files);
    const a = await extractToolchain(docs);
    const b = await extractToolchain([...docs].reverse());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('tags every node with its format and marks it non-analyzable for coverage', async () => {
    const { docs } = fixture(files);
    const { nodes } = await extractToolchain(docs);
    expect(nodes.length).toBeGreaterThan(0);
    for (const node of nodes) {
      expect(node.tested).toBeNull();
      expect(node.lang).toBeTruthy();
    }
  });

  it('joins a CI job to the workload running the image it builds', async () => {
    const { docs } = fixture(files);
    const { nodes, edges, linkCounts } = await extractToolchain(docs);
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const deploys = edges.filter(
      (e) => e.kind === 'deploys' && byId.get(e.src)?.qualifiedName === 'job:build',
    );
    expect(deploys).toHaveLength(1);
    expect(byId.get(deploys[0].dst)?.qualifiedName).toBe('default/Deployment/web');
    expect(linkCounts['ci→workload']).toBe(1);
  });

  it('joins a CI job to the terraform resources it applies', async () => {
    const { docs } = fixture(files);
    const { nodes, edges } = await extractToolchain(docs);
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const applied = edges.filter(
      (e) => e.kind === 'deploys' && byId.get(e.src)?.qualifiedName === 'tfdir:infra',
    );
    expect(applied.map((e) => byId.get(e.dst)?.qualifiedName)).toEqual(['aws_eks_cluster.main']);
  });

  it('labels every inferred edge as heuristic and name-matched', async () => {
    const { docs } = fixture(files);
    const { edges } = await extractToolchain(docs);
    for (const edge of edges) {
      expect(edge.resolution).toBe('heuristic');
      expect(['declared', 'name-matched']).toContain(edge.epistemic);
      if (edge.epistemic === 'name-matched') expect(edge.confidence).toBeLessThan(1);
    }
  });

  it('never emits a dangling edge', async () => {
    const { docs } = fixture(files);
    const { nodes, edges } = await extractToolchain(docs);
    const ids = new Set(nodes.map((n) => n.id));
    for (const edge of edges) {
      // A `dockerfile→source` edge points at a code file node, which this
      // fixture does not supply, so only same-set edges are asserted here.
      if (!ids.has(edge.dst)) continue;
      expect(ids.has(edge.src)).toBe(true);
    }
  });

  it('ignores files no extractor claims', async () => {
    const { docs } = fixture({ 'README.md': '# hello\n', 'src/index.ts': 'export const a = 1;\n' });
    const result = await extractToolchain(docs);
    expect(result.nodes).toEqual([]);
  });

  it('never serialises a draft attrs projection into the graph', async () => {
    const { docs } = fixture({
      ...files,
      'infra/sg.tf': 'resource "aws_security_group" "web" {\n  ingress { from_port = 22 cidr_blocks = ["0.0.0.0/0"] }\n  master_password = "graph-secret-sentinel"\n}\n',
    });
    const { nodes, edges } = await extractToolchain(docs);
    const drafts = await extractToolchainDrafts(docs);
    // The drafts do carry projections…
    expect(drafts.some((d) => d.draft.attrs !== undefined)).toBe(true);
    // …and none of them reaches a graph node: the graph is byte-identical with
    // or without attrs support, and a redacted value stays out of graph.json.
    for (const node of nodes) expect(Object.hasOwn(node, 'attrs')).toBe(false);
    const serialised = JSON.stringify({ nodes, edges });
    expect(serialised).not.toContain('attrs');
    expect(serialised).not.toContain('graph-secret-sentinel');
  });

  it('gives every draft the exact node id the graph uses, in the graph’s file order', async () => {
    const { docs } = fixture(files);
    const { nodes } = await extractToolchain(docs);
    const drafts = await extractToolchainDrafts([...docs].reverse());
    const graphIds = new Set(nodes.map((n) => n.id));
    expect(drafts.length).toBe(nodes.length);
    for (const record of drafts) {
      expect(graphIds.has(record.nodeId)).toBe(true);
      const node = nodes.find((n) => n.id === record.nodeId)!;
      expect(node.qualifiedName).toBe(record.draft.qualifiedName);
      expect(node.file).toBe(record.rel);
      expect(node.lang).toBe(record.format);
    }
    // Sorted path order, independent of discovery order.
    const rels = drafts.map((d) => d.rel);
    expect(rels).toEqual([...rels].sort((a, b) => a.localeCompare(b, 'en')));
  });
});

describe('buildProjectProfile', () => {
  it('describes the project deterministically from declared evidence', async () => {
    const { docs } = fixture({
      'infra/main.tf': 'resource "aws_eks_cluster" "main" { name = "prod" }\n',
      'k8s/web.yaml':
        'apiVersion: apps/v1\nkind: Deployment\nmetadata: { name: web }\nspec:\n  template:\n    spec:\n      containers: [{ name: c, image: nginx }]\n',
    });
    const { nodes } = await extractToolchain(docs);
    const profile = buildProjectProfile({
      nodes: [
        ...nodes,
        {
          id: 'x',
          kind: 'function',
          name: 'f',
          qualifiedName: 'f',
          file: 'src/a.ts',
          span: { start: 1, end: 1 },
          lang: 'ts',
          importance: 0.5,
          centrality: { degree: 0, pagerank: 0, betweenness: 0, eigenvector: 0 },
          area: -1,
          isHub: false,
          tested: null,
        },
      ],
      files: ['package.json', 'pnpm-workspace.yaml', '.github/workflows/cd.yml', 'infra/main.tf'],
    });

    expect(profile.languages[0]).toEqual({ id: 'ts', nodes: 1 });
    expect(profile.monorepo).toBe('pnpm workspaces');
    expect(profile.ciSystems).toEqual(['GitHub Actions']);
    expect(profile.iac).toEqual(['Terraform']);
    expect(profile.counts.workloads).toBe(1);
    expect(profile.summary).toContain('ts monorepo (pnpm workspaces)');
    expect(profile.summary).toContain('Terraform');
  });
});
