import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { scanDocker } from '../src/core-open/scanners/docker-scanner.js';

describe('Dockerfile FROM parsing', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-docker-from-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('reads lowercase and indented FROM instructions', async () => {
    fs.writeFileSync(
      path.join(root, 'Dockerfile'),
      [
        'from node:20-alpine',
        '  FROM --platform=linux/amd64 python:3.12-slim AS tools',
        '# FROM ignored:alpine',
        'FROM scratch',
      ].join('\n'),
    );

    const scan = await scanDocker(root, undefined, undefined, true);

    expect(scan?.dependencies.map((dep) => dep.package)).toEqual([
      'library/node',
      'library/python',
    ]);
  });
});
