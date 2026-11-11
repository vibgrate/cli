import { describe, expect, it } from 'vitest';
import { parseDockerImage, type DockerImageRef } from '../src/core-open/scanners/docker-cache.js';

const HEX = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const DIGEST = `sha256:${HEX}`;

function parsed(fields: DockerImageRef): DockerImageRef {
  return {
    registry: undefined,
    namespace: undefined,
    tag: undefined,
    digest: undefined,
    ...fields,
  };
}

const cases: Array<{ ref: string; expected: DockerImageRef }> = [
  {
    ref: 'nginx',
    expected: parsed({ image: 'nginx' }),
  },
  {
    ref: 'nginx:1.27',
    expected: parsed({ image: 'nginx', tag: '1.27' }),
  },
  {
    ref: 'bitnami/redis:7',
    expected: parsed({ namespace: 'bitnami', image: 'redis', tag: '7' }),
  },
  {
    ref: 'ghcr.io/acme/api:1.4.0',
    expected: parsed({ registry: 'ghcr.io', namespace: 'acme', image: 'api', tag: '1.4.0' }),
  },
  {
    ref: 'localhost:5000/team/app:1.2.3',
    expected: parsed({ registry: 'localhost:5000', namespace: 'team', image: 'app', tag: '1.2.3' }),
  },
  {
    ref: `node:20@${DIGEST}`,
    expected: parsed({ image: 'node', tag: '20', digest: DIGEST }),
  },
  {
    ref: `node@${DIGEST}`,
    expected: parsed({ image: 'node', digest: DIGEST }),
  },
  {
    ref: 'node:18-alpine',
    expected: parsed({ image: 'node', tag: '18-alpine' }),
  },
  {
    ref: `localhost:5000/team/app:1.2.3@${DIGEST}`,
    expected: parsed({
      registry: 'localhost:5000',
      namespace: 'team',
      image: 'app',
      tag: '1.2.3',
      digest: DIGEST,
    }),
  },
];

describe('parseDockerImage', () => {
  it.each(cases)('$ref', ({ ref, expected }) => {
    expect(parseDockerImage(ref)).toEqual(expected);
  });
});
