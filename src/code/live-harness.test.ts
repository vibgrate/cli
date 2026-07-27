import { describe, it, expect } from 'vitest';
import { runLiveFusionArm } from './live-harness.js';
import { ScriptedProvider } from './providers.js';
import type { ToolCall } from './types.js';

const tc = (name: string, args: Record<string, unknown>, id: string): ToolCall => ({
  id,
  name,
  arguments: args,
});

describe('live fusion harness', () => {
  it('runs a single task with a scripted provider (no network)', async () => {
    const provider = new ScriptedProvider('live-test', [
      {
        toolCalls: [
          tc(
            'edit_file',
            { path: 'a.ts', search: 'const x = 1;', replace: 'const x = 2;' },
            'c1',
          ),
        ],
      },
      { toolCalls: [tc('finish', { summary: 'done' }, 'c2')] },
    ]);
    const { report, results } = await runLiveFusionArm(
      [
        {
          id: 'live-unit-1',
          instruction: 'bump x to 2',
          files: { 'a.ts': 'const x = 1;\n' },
          scripts: {}, // unused for live arm
        },
      ],
      { provider, arm: 'capsule', maxSteps: 8 },
    );
    expect(results).toHaveLength(1);
    expect(results[0]!.agent?.stopped).toBe('finished');
    expect(report.capsuleRuns).toBe(1);
  });
});
