import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scanDocker } from './docker-scanner.js';

/**
 * Dockerfile instructions are case-insensitive and may be indented, so a base
 * image declared as `from node:20` or as an indented `FROM python:3.12-slim AS
 * tools` has to be reported just like an uppercase, flush-left one. Commented
 * out instructions (`# FROM node:18`) and `scratch` stay out of the result.
 */

const tempDirs: string[] = [];

async function projectWithDockerfile(contents: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vg-docker-'));
  tempDirs.push(dir);
  await fs.writeFile(path.join(dir, 'Dockerfile'), contents, 'utf8');
  return dir;
}

async function baseImages(dockerfile: string): Promise<string[]> {
  const dir = await projectWithDockerfile(dockerfile);
  const scan = await scanDocker(dir, undefined, undefined, true);
  return scan ? scan.dependencies.map((dependency) => dependency.package) : [];
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('Dockerfile base image parsing', () => {
  it('reads uppercase, multi-stage base images including --platform', async () => {
    const images = await baseImages(
      [
        'FROM --platform=linux/amd64 node:20 AS build',
        'RUN npm ci',
        'FROM python:3.12-slim',
      ].join('\n'),
    );

    expect(images).toEqual(['library/node', 'library/python']);
  });

  it('reads lowercase and indented FROM instructions', async () => {
    const images = await baseImages(
      ['from node:20', '  FROM python:3.12-slim AS tools', '\tfrom alpine:3.20'].join('\n'),
    );

    expect(images).toEqual(['library/node', 'library/python', 'library/alpine']);
  });

  it('ignores commented-out and scratch base images', async () => {
    const images = await baseImages(
      ['# FROM node:18', 'FROM scratch', 'FROM ghcr.io/owner/image:1.2.3'].join('\n'),
    );

    expect(images).toEqual(['owner/image']);
  });

  it('returns no scan when the Dockerfile declares no base image', async () => {
    const dir = await projectWithDockerfile('# FROM node:20\n');

    expect(await scanDocker(dir, undefined, undefined, true)).toBeNull();
  });
});
