import { describe, it, expect } from 'vitest';
import { toolResultLogLines } from './interactive.js';

describe('toolResultLogLines', () => {
  it('prints only the first line for non-read tools', () => {
    expect(toolResultLogLines('edit_file', 'updated src/greet.ts\nmore')).toEqual(['updated src/greet.ts']);
  });

  it('prints header plus first ~3 content lines for read_file', () => {
    const content = [
      'resolved path from src/gREET.ts → src/greet.ts. src/greet.ts (2 lines):',
      'export function greet(name: string) {',
      '  return `hi ${name}`;',
      '}',
      'trailing should not appear',
    ].join('\n');
    const lines = toolResultLogLines('read_file', content);
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(/resolved path from src\/gREET\.ts/);
    expect(lines[1]).toContain('export function greet');
    expect(lines.at(-1)).not.toMatch(/trailing/);
  });
});
