import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { scanDocker } from '../src/core-open/scanners/docker-scanner.js';
import type { ProjectScan } from '../src/core-open/types.js';

async function writeProject(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibgrate-docker-arg-'));
  for (const [name, body] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, name), body);
  }
  return dir;
}

function imageRows(scan: ProjectScan | null): Array<{ package: string; currentSpec: string }> {
  return (scan?.dependencies ?? []).map((row) => ({
    package: row.package,
    currentSpec: row.currentSpec,
  }));
}

function expectNoArgText(scan: ProjectScan | null): void {
  for (const row of scan?.dependencies ?? []) {
    for (const value of [row.package, row.currentSpec, row.resolvedVersion ?? '']) {
      expect(value).not.toMatch(/\$\{/);
      expect(value).not.toMatch(/\$[A-Za-z_]/);
    }
  }
}

describe('scanDocker ARG defaults in FROM', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it('substitutes nested ARG defaults so FROM ${BASE} is library/node:20-alpine', async () => {
    const dir = await writeProject({
      Dockerfile: [
        'ARG NODE_VERSION=20',
        'ARG BASE=node:${NODE_VERSION}-alpine',
        'FROM ${BASE}',
        '',
      ].join('\n'),
    });
    dirs.push(dir);

    const scan = await scanDocker(dir, undefined, undefined, true);
    expect(imageRows(scan)).toEqual([{ package: 'library/node', currentSpec: '20-alpine' }]);
    expectNoArgText(scan);
  });

  it('substitutes both $NAME and ${NAME} forms', async () => {
    const dir = await writeProject({
      Dockerfile: [
        'ARG NODE_VERSION=20',
        'FROM node:$NODE_VERSION-alpine',
        'ARG TAG=22',
        'FROM node:${TAG}',
        '',
      ].join('\n'),
    });
    dirs.push(dir);

    const scan = await scanDocker(dir, undefined, undefined, true);
    expect(imageRows(scan)).toEqual([
      { package: 'library/node', currentSpec: '20-alpine' },
      { package: 'library/node', currentSpec: '22' },
    ]);
    expectNoArgText(scan);
  });

  it('emits no row for FROM $UNSET when the variable has no default', async () => {
    const dir = await writeProject({
      Dockerfile: 'FROM $UNSET\n',
    });
    dirs.push(dir);

    const scan = await scanDocker(dir, undefined, undefined, true);
    expect(scan).toBeNull();
  });

  it('skips unresolved FROM lines and does not leave ${...} in image rows', async () => {
    const dir = await writeProject({
      Dockerfile: [
        'FROM $UNSET',
        'ARG BASE=node:${MISSING}-alpine',
        'FROM ${BASE}',
        'ARG NODE_VERSION=20',
        'ARG BASE=node:${NODE_VERSION}-alpine',
        'FROM ${BASE}',
        'FROM node:${ALSO_MISSING}',
        '',
      ].join('\n'),
    });
    dirs.push(dir);

    const scan = await scanDocker(dir, undefined, undefined, true);
    expect(imageRows(scan)).toEqual([{ package: 'library/node', currentSpec: '20-alpine' }]);
    expectNoArgText(scan);
  });

  it('uses a quoted ARG default and a quoted FROM reference', async () => {
    const dir = await writeProject({
      Dockerfile: [
        'ARG NODE_VERSION="20"',
        'ARG BASE="node:${NODE_VERSION}-alpine"',
        'FROM "${BASE}"',
        '',
      ].join('\n'),
    });
    dirs.push(dir);

    const scan = await scanDocker(dir, undefined, undefined, true);
    expect(imageRows(scan)).toEqual([{ package: 'library/node', currentSpec: '20-alpine' }]);
    expectNoArgText(scan);
  });
});
