import { describe, it, expect, afterEach } from 'vitest';
import { buildGraph } from '../src/engine/build.js';
import {
  classifyProjectContext,
  discoverDocs,
  documentNodesFromDocs,
  isDocPath,
  prepareDocBody,
  projectContextExactBasenames,
} from '../src/engine/docs-ingest.js';
import { nodeEmbedText } from '../src/engine/embeddings.js';
import { makeProject, cleanup } from './helpers.js';

const PIN = '2020-01-01T00:00:00.000Z';
const dirs: string[] = [];
function project(files: Record<string, string>): string {
  const d = makeProject(files);
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) cleanup(dirs.pop()!);
});

describe('classifyProjectContext / isDocPath', () => {
  it('accepts human docs and env examples — not live .env', () => {
    expect(isDocPath('README.md')).toBe(true);
    expect(isDocPath('docs/guide.mdx')).toBe(true);
    expect(isDocPath('notes.txt')).toBe(true);
    expect(isDocPath('.env.example')).toBe(true);
    expect(isDocPath('example.env')).toBe(true);
    expect(classifyProjectContext('.env')).toBeNull();
    expect(classifyProjectContext('.env.local')).toBeNull();
    expect(isDocPath('src/app.ts')).toBe(false);
  });

  it('classifies manifests, docker, compose, CI, API contracts, task runners', () => {
    expect(classifyProjectContext('package.json')).toBe('manifest');
    expect(classifyProjectContext('apps/web/package.json')).toBe('manifest');
    expect(classifyProjectContext('pyproject.toml')).toBe('manifest');
    expect(classifyProjectContext('go.mod')).toBe('manifest');
    expect(classifyProjectContext('Cargo.toml')).toBe('manifest');
    expect(classifyProjectContext('pnpm-workspace.yaml')).toBe('workspace');
    expect(classifyProjectContext('Dockerfile')).toBe('docker');
    expect(classifyProjectContext('Dockerfile.prod')).toBe('docker');
    expect(classifyProjectContext('docker-compose.yml')).toBe('compose');
    expect(classifyProjectContext('compose.yaml')).toBe('compose');
    expect(classifyProjectContext('.github/workflows/ci.yml')).toBe('ci');
    expect(classifyProjectContext('.gitlab-ci.yml')).toBe('ci');
    expect(classifyProjectContext('tsconfig.json')).toBe('build-config');
    expect(classifyProjectContext('tsconfig.build.json')).toBe('build-config');
    expect(classifyProjectContext('vite.config.ts')).toBe('build-config');
    expect(classifyProjectContext('openapi.yaml')).toBe('api-contract');
    expect(classifyProjectContext('api/schema.graphql')).toBe('api-contract');
    expect(classifyProjectContext('proto/user.proto')).toBe('api-contract');
    expect(classifyProjectContext('Makefile')).toBe('task-runner');
    expect(classifyProjectContext('Justfile')).toBe('task-runner');
    expect(classifyProjectContext('vercel.json')).toBe('infra');
    expect(classifyProjectContext('wrangler.toml')).toBe('infra');
    expect(classifyProjectContext('package-lock.json')).toBeNull();
    expect(classifyProjectContext('yarn.lock')).toBeNull();
  });

  it('exports a stable exact-basename catalogue', () => {
    const names = projectContextExactBasenames();
    expect(names).toContain('package.json');
    expect(names).toContain('dockerfile');
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });
});

describe('prepareDocBody', () => {
  it('summarizes large package.json to scripts and deps', () => {
    const big: Record<string, unknown> = {
      name: 'demo',
      scripts: { test: 'vitest', build: 'tsc' },
      dependencies: { leftpad: '1.0.0' },
      devDependencies: { vitest: '1.0.0' },
      fluff: 'x'.repeat(20_000),
    };
    const body = prepareDocBody('package.json', JSON.stringify(big), 'manifest');
    expect(body).toContain('"test"');
    expect(body).toContain('leftpad');
    expect(body.length).toBeLessThan(9000);
    expect(body).not.toContain('xxx'); // fluff key dropped in summary path when parse works
  });
});

describe('discoverDocs + document nodes (deep project context)', () => {
  it('ingests md/txt/env.example and redacts secret shapes', () => {
    const root = project({
      'README.md': '# Showmens\n\nStart the app with `npm start`.\n',
      'notes.txt': 'Ops notes for grounds page refresh.\n',
      '.env.example': 'API_URL=https://example.com\nOPENAI_API_KEY=sk-abcdefghijklmnop\n',
      '.env': 'OPENAI_API_KEY=sk-live-should-never-ingest\n',
      'src/app.ts': 'export function main(){ return 1; }\n',
    });
    const docs = discoverDocs({ root });
    expect(docs.map((d) => d.rel).sort()).toEqual(['.env.example', 'README.md', 'notes.txt']);
    expect(docs.some((d) => d.rel === '.env')).toBe(false);

    const nodes = documentNodesFromDocs(docs);
    expect(nodes.every((n) => n.kind === 'document')).toBe(true);
    const env = nodes.find((n) => n.file === '.env.example')!;
    expect(env.doc).toContain('API_URL');
    expect(env.doc).not.toContain('sk-abcdefghijklmnop');
    expect(env.doc).toMatch(/redacted/i);
  });

  it('ingests package.json, Dockerfile, compose, CI, openapi, Makefile', () => {
    const root = project({
      'package.json': JSON.stringify({
        name: 'guild',
        scripts: { start: 'node app.js', test: 'vitest' },
        dependencies: { vue: '2.0.0' },
      }),
      Dockerfile: 'FROM node:20\nWORKDIR /app\nCOPY . .\nCMD ["npm","start"]\n',
      'docker-compose.yml': 'services:\n  api:\n    build: .\n    ports: ["3000:3000"]\n',
      '.github/workflows/ci.yml': 'name: CI\non: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n',
      'openapi.yaml': 'openapi: 3.0.0\ninfo:\n  title: Guild API\npaths:\n  /health:\n    get:\n      summary: ok\n',
      Makefile: 'test:\n\tnpm test\nbuild:\n\tnpm run build\n',
      'tsconfig.json': '{ "compilerOptions": { "strict": true } }\n',
      'src/main.ts': 'export const x = 1;\n',
    });
    const docs = discoverDocs({ root });
    const rels = docs.map((d) => d.rel).sort();
    expect(rels).toEqual(
      expect.arrayContaining([
        'package.json',
        'Dockerfile',
        'docker-compose.yml',
        '.github/workflows/ci.yml',
        'openapi.yaml',
        'Makefile',
        'tsconfig.json',
      ]),
    );
    expect(docs.find((d) => d.rel === 'package.json')?.category).toBe('manifest');
    expect(docs.find((d) => d.rel === 'Dockerfile')?.category).toBe('docker');
    expect(docs.find((d) => d.rel === '.github/workflows/ci.yml')?.category).toBe('ci');

    const nodes = documentNodesFromDocs(docs);
    const pkg = nodes.find((n) => n.file === 'package.json')!;
    expect(pkg.signature).toBe('document:manifest');
    expect(pkg.doc).toContain('vitest');
    expect(pkg.importance).toBeGreaterThan(0.1);

    const text = nodeEmbedText(pkg);
    expect(text.toLowerCase()).toMatch(/dependencies|scripts/);
  });

  it('buildGraph attaches document nodes for full project context', async () => {
    const root = project({
      'README.md': '# Guild app\n\nInitializes Sentry on launch.\n',
      'package.json': JSON.stringify({ name: 'guild', scripts: { start: 'node .' } }),
      'docker-compose.yml': 'services:\n  web:\n    image: nginx\n',
      'src/util.js': 'export function initSentry(){ return 1; }\n',
    });
    const { graph } = await buildGraph({ root, generatedAt: PIN, inline: true });
    const docs = graph.nodes.filter((n) => n.kind === 'document');
    const files = docs.map((n) => n.file).sort();
    expect(files).toEqual(expect.arrayContaining(['README.md', 'package.json', 'docker-compose.yml']));
    expect(nodeEmbedText(docs.find((n) => n.file === 'docker-compose.yml')!).toLowerCase()).toMatch(
      /compose|services|nginx/,
    );
  });

  it('skips backup trees and lockfiles', () => {
    const root = project({
      'README.md': 'root readme\n',
      'package-lock.json': '{}\n',
      '.migration_backup/old.md': 'should not ingest\n',
      'yarn.lock': 'x\n',
    });
    const docs = discoverDocs({ root });
    expect(docs.map((d) => d.rel)).toEqual(['README.md']);
  });
});
