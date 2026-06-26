import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Create a throwaway project directory from a map of {relpath: contents} and
 * return its absolute path. Tests build into temp dirs so fixtures stay clean
 * and runs are hermetic.
 */
export function makeProject(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-test-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return dir;
}

export function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** A small multi-language project exercising calls/imports/contains/extends. */
export const SAMPLE_FILES: Record<string, string> = {
  'src/math.ts': [
    'export function add(a: number, b: number): number {',
    '  return a + b;',
    '}',
    'export function double(x: number): number {',
    '  return add(x, x);',
    '}',
    '',
  ].join('\n'),
  'src/order.ts': [
    "import { double } from './math';",
    '',
    'export interface Entity { id: string; }',
    '',
    'export class OrderService {',
    '  total = 0;',
    '  addItem(price: number): void {',
    '    this.total = double(price);',
    '  }',
    '  deleteAsync(id: string): void {',
    '    this.addItem(0);',
    '  }',
    '}',
    '',
    'export class PaidOrderService extends OrderService {',
    '  pay(): void { this.addItem(1); }',
    '}',
    '',
  ].join('\n'),
  'svc/app.py': [
    'import os',
    '',
    'class Base:',
    '    def run(self):',
    '        return helper()',
    '',
    'def helper():',
    '    return os.getpid()',
    '',
  ].join('\n'),
};
