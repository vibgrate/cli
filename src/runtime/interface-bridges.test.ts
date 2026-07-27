import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  discoverInterfaceBridges,
  extractComposeBuildContexts,
  extractGraphqlRefs,
  extractOpenApiRefs,
  extractProtoImports,
  type InterfaceBridgeFs,
} from './interface-bridges.js';

function memFs(files: Record<string, string>): InterfaceBridgeFs {
  const map = new Map(Object.entries(files).map(([k, v]) => [path.resolve(k), v]));
  const dirs = new Set<string>();
  for (const f of map.keys()) {
    let cur = path.dirname(f);
    for (let i = 0; i < 12; i++) {
      dirs.add(cur);
      const p = path.dirname(cur);
      if (p === cur) break;
      cur = p;
    }
  }
  return {
    readFile(abs) {
      return map.get(path.resolve(abs)) ?? null;
    },
    readdir(abs) {
      const root = path.resolve(abs);
      const names = new Set<string>();
      for (const d of dirs) {
        if (path.dirname(d) === root) names.add(path.basename(d));
      }
      for (const f of map.keys()) {
        if (path.dirname(f) === root) names.add(path.basename(f));
      }
      return [...names].sort((a, b) => a.localeCompare(b));
    },
    isDirectory(abs) {
      const p = path.resolve(abs);
      return dirs.has(p) || [...map.keys()].some((f) => path.dirname(f) === p);
    },
  };
}

describe('extractOpenApiRefs', () => {
  it('collects file $refs from JSON and YAML shapes', () => {
    const refs = extractOpenApiRefs(`
      { "openapi": "3.0.0", "paths": { "/x": { "$ref": "../shared/paths.yaml" } } }
      $ref: '../shared/components.yaml#/Foo'
      $ref: "https://example.com/remote.yaml"
    `);
    expect(refs).toContain('../shared/paths.yaml');
    expect(refs.some((r) => r.startsWith('http'))).toBe(false);
  });
});

describe('extractComposeBuildContexts', () => {
  it('parses simple and context-form build paths', () => {
    const ctx = extractComposeBuildContexts(`
services:
  api:
    build: ../packages/api
  web:
    build:
      context: ../packages/web
      dockerfile: Dockerfile
`);
    expect(ctx).toEqual(['../packages/api', '../packages/web']);
  });
});

describe('extractProtoImports', () => {
  it('parses import statements and skips google/protobuf', () => {
    const imps = extractProtoImports(`
syntax = "proto3";
import "google/protobuf/timestamp.proto";
import public "shared/common.proto";
import "api/v1/types.proto";
`);
    expect(imps).toEqual(['api/v1/types.proto', 'shared/common.proto']);
  });
});

describe('discoverInterfaceBridges', () => {
  it('links OpenAPI $ref across members', () => {
    const api = '/mono/packages/api';
    const shared = '/mono/packages/shared';
    const fs = memFs({
      [`${api}/openapi.yaml`]: 'openapi: 3.0.0\npaths:\n  /x:\n    $ref: ../shared/paths.yaml\n',
      [`${shared}/paths.yaml`]: 'get:\n  summary: x\n',
    });
    const edges = discoverInterfaceBridges(
      [{ root: api }, { root: shared }],
      fs,
    );
    expect(edges.some((e) => e.kind === 'openapi-ref' && e.toRoot === path.resolve(shared))).toBe(true);
    expect(edges.find((e) => e.kind === 'openapi-ref')?.confidence).toBe(0.7);
  });

  it('links compose build contexts across members', () => {
    const root = '/mono';
    const api = '/mono/packages/api';
    const fs = memFs({
      [`${root}/docker-compose.yml`]: 'services:\n  api:\n    build: ./packages/api\n',
      [`${api}/package.json`]: '{"name":"api"}',
    });
    const edges = discoverInterfaceBridges([{ root }, { root: api }], fs);
    expect(edges.some((e) => e.kind === 'compose-service' && e.toRoot === path.resolve(api))).toBe(true);
  });

  it('links protobuf imports by member basename prefix', () => {
    const a = '/mono/services/a';
    const b = '/mono/services/b';
    const fs = memFs({
      [`${a}/rpc.proto`]: 'syntax = "proto3";\nimport "b/types.proto";\n',
      [`${b}/types.proto`]: 'syntax = "proto3";\n',
    });
    const edges = discoverInterfaceBridges([{ root: a }, { root: b }], fs);
    expect(edges.some((e) => e.kind === 'protobuf-import' && e.toRoot === path.resolve(b))).toBe(true);
  });

  it('is deterministic', () => {
    const api = '/r/api';
    const lib = '/r/lib';
    const fs = memFs({
      [`${api}/openapi.json`]: '{"openapi":"3.0.0","$ref":"../lib/x.yaml"}',
      [`${lib}/x.yaml`]: 'x: 1\n',
    });
    const members = [{ root: api }, { root: lib }];
    expect(discoverInterfaceBridges(members, fs)).toEqual(discoverInterfaceBridges(members, fs));
  });

  it('links GraphQL #import across members', () => {
    const a = '/mono/a';
    const b = '/mono/b';
    const fs = memFs({
      [`${a}/schema.graphql`]: '#import "../b/user.graphql"\ntype Query { me: User }\n',
      [`${b}/user.graphql`]: 'type User { id: ID! }\n',
    });
    const edges = discoverInterfaceBridges([{ root: a }, { root: b }], fs);
    expect(edges.some((e) => e.kind === 'graphql-ref' && e.toRoot === path.resolve(b))).toBe(true);
    expect(extractGraphqlRefs('#import * from "../b/user.graphql"\n')).toEqual(['../b/user.graphql']);
  });
});
