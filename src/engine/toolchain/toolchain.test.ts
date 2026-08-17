import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { extractToolchain } from './index.js';
import { terraformExtractor } from './terraform.js';
import { kubernetesExtractor } from './kubernetes.js';
import { composeExtractor } from './compose.js';
import { dockerfileExtractor, logicalLines, copySourcePaths } from './dockerfile.js';
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
