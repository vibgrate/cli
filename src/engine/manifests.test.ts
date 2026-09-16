import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { extractManifests } from './manifests.js';

let dir: string | undefined;

afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function write(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

describe('extractManifests', () => {
  it('extracts a package.json (baseline, pre-existing behavior)', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-manifest-'));
    write(dir, 'package.json', JSON.stringify({ name: '@acme/api', dependencies: { express: '^4.0.0' } }));
    const out = extractManifests(dir);
    const pkg = out.nodes.find((n) => n.kind === 'package');
    expect(pkg?.name).toBe('api');
    expect(pkg?.qualifiedName).toBe('@acme/api');
    expect(out.deps).toBe(1);
  });

  it('extracts a Maven pom.xml as a package node with its dependencies', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-manifest-'));
    write(
      dir,
      'pom.xml',
      `<?xml version="1.0"?>
<project>
  <groupId>org.springframework.samples</groupId>
  <artifactId>spring-petclinic</artifactId>
  <name>petclinic</name>
  <dependencies>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-web</artifactId>
    </dependency>
  </dependencies>
</project>`,
    );
    const out = extractManifests(dir);
    const pkg = out.nodes.find((n) => n.kind === 'package');
    expect(pkg?.name).toBe('petclinic');
    expect(pkg?.qualifiedName).toBe('org.springframework.samples:spring-petclinic');
    expect(out.deps).toBe(1);
    const ext = out.nodes.find((n) => n.kind === 'external');
    expect(ext?.name).toBe('org.springframework.boot:spring-boot-starter-web');
  });

  it('extracts a .csproj as its own project, distinct from a sibling .csproj', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-manifest-'));
    write(
      dir,
      'src/ApplicationCore/ApplicationCore.csproj',
      `<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <PackageReference Include="Ardalis.GuardClauses" />
  </ItemGroup>
</Project>`,
    );
    write(
      dir,
      'src/Web/Web.csproj',
      `<Project Sdk="Microsoft.NET.Sdk.Web">
  <ItemGroup>
    <PackageReference Include="Microsoft.AspNetCore.App" />
  </ItemGroup>
</Project>`,
    );
    const out = extractManifests(dir);
    const pkgs = out.nodes.filter((n) => n.kind === 'package').map((n) => n.name).sort();
    expect(pkgs).toEqual(['ApplicationCore', 'Web']);
    expect(out.deps).toBe(2);
  });

  it('extracts a pyproject.toml, preferring PEP 621 [project] over [tool.poetry]', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-manifest-'));
    write(
      dir,
      'pyproject.toml',
      `[project]
name = "Flask"
dependencies = ["click>=8.1.3", "jinja2>=3.1.2"]
`,
    );
    const out = extractManifests(dir);
    const pkg = out.nodes.find((n) => n.kind === 'package');
    expect(pkg?.name).toBe('Flask');
    expect(out.deps).toBe(2);
    const extNames = out.nodes.filter((n) => n.kind === 'external').map((n) => n.name).sort();
    expect(extNames).toEqual(['click', 'jinja2']);
  });

  it('extracts a Cargo.toml', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-manifest-'));
    write(
      dir,
      'Cargo.toml',
      `[package]
name = "vibgrate-haile-kernel"

[dependencies]
serde = "1"
`,
    );
    const out = extractManifests(dir);
    const pkg = out.nodes.find((n) => n.kind === 'package');
    expect(pkg?.name).toBe('vibgrate-haile-kernel');
    expect(out.deps).toBe(1);
  });

  it('gives each ecosystem its own package node in a mixed-ecosystem tree', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-manifest-'));
    write(dir, 'services/api/package.json', JSON.stringify({ name: 'api' }));
    write(dir, 'services/worker/go.mod', 'module example.com/worker\n');
    write(dir, 'services/legacy/pom.xml', '<project><artifactId>legacy</artifactId></project>');
    const out = extractManifests(dir);
    const names = out.nodes.filter((n) => n.kind === 'package').map((n) => n.name).sort();
    expect(names).toEqual(['api', 'legacy', 'worker']);
  });
});
