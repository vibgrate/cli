import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BOARD_LAYOUT_MAGIC,
  defaultBoardLayout,
  parseBoardLayout,
  readBoardLayout,
  writeBoardLayout,
} from './board-layout.js';

let dir: string | undefined;

afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('board.arch.json', () => {
  it('rejects a file that is not this map', () => {
    expect(parseBoardLayout({ magic: 'nope' })).toBeNull();
    expect(parseBoardLayout(null)).toBeNull();
  });

  it('defaults density and drops bad coordinates', () => {
    const parsed = parseBoardLayout({
      magic: BOARD_LAYOUT_MAGIC,
      density: 'loud',
      positions: { a: { x: 1, y: 2 }, b: { x: 'nope', y: 0 }, c: { x: Infinity, y: 1 } },
    });
    expect(parsed?.density).toBe('expanded');
    expect(parsed?.positions).toEqual({ a: { x: 1, y: 2 } });
  });

  it('round-trips through .vibgrate/board.arch.json', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-arch-layout-'));
    expect(readBoardLayout(dir)).toBeNull();
    const saved = writeBoardLayout(dir, {
      ...defaultBoardLayout(),
      density: 'compact',
      zoom: 'slice',
      packageId: 'pkg-api',
      positions: { 'card:1': { x: 12.34, y: 56.78 } },
    });
    expect(saved.density).toBe('compact');
    const disk = JSON.parse(fs.readFileSync(path.join(dir, '.vibgrate', 'board.arch.json'), 'utf8')) as {
      magic: string;
    };
    expect(disk.magic).toBe(BOARD_LAYOUT_MAGIC);
    const read = readBoardLayout(dir);
    expect(read?.packageId).toBe('pkg-api');
    expect(read?.positions['card:1']).toEqual({ x: 12.3, y: 56.8 });
  });
});
