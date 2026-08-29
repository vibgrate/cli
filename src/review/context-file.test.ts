import { describe, expect, it } from 'vitest';
import { BLOCK_END, BLOCK_START, injectContextBlock, renderContext } from './context-file.js';
import type { DominanceVote } from './dominance.js';
import type { ReviewReceipt } from './schemas.js';

function vote(overrides: Partial<DominanceVote> = {}): DominanceVote {
  return {
    group: 'role:routing',
    groupKind: 'role',
    dominant: 'via-service',
    share: 0.8,
    entropy: 0.3,
    size: 5,
    reason: 'dominant',
    tally: { 'via-service': 8, 'direct-persistence': 2 },
    deviators: ['src/routes/e.ts'],
    exemplars: ['src/routes/a.ts', 'src/routes/b.ts'],
    ...overrides,
  };
}

function receipt(overrides: Partial<ReviewReceipt> = {}): ReviewReceipt {
  return {
    decision: 'needs_review',
    counts: { architecture: 1, security: 0, protected: 0, unknowns: 0 },
    git: { head_sha: 'abcdef1234567890' },
    findings: {
      architecture_findings: [
        {
          id: 'arch-01',
          kind: 'peer_deviation',
          claim: 'It bypasses the service layer.',
          remediation: 'Go through the service.',
          protected_finding: false,
        },
      ],
      security_findings: [],
    },
    ...overrides,
  } as unknown as ReviewReceipt;
}

const base = {
  receipt: receipt(),
  votes: [vote()],
  declaredTarget: null as string | null,
  intentSources: [] as string[],
};

describe('renderContext', () => {
  it('tells the agent to follow the declared target, not the majority', () => {
    // The whole difference from a consistency scanner's context file. A repo
    // mid-migration must not have its own memory instruct agents to perpetuate
    // the legacy it is migrating away from.
    const md = renderContext({ ...base, declaredTarget: 'layered', intentSources: ['CLAUDE.md'] });
    expect(md).toContain('Declared target: `layered`');
    expect(md).toContain('**not** to match whatever most of the existing');
    expect(md).toContain('the target wins');
    expect(md).toContain('`CLAUDE.md`');
  });

  it('marks observed conventions as observation, not instruction, with no target', () => {
    const md = renderContext(base);
    expect(md).toContain('No target architecture has been declared');
    expect(md).toContain('an observation, not an instruction');
    // It must actively warn that the convention may be the thing being migrated
    // away from, rather than presenting it as the house style to copy.
    expect(md).toContain('may be exactly what the team is trying to move away from');
  });

  it('lists conventions with exemplars an agent can open', () => {
    const md = renderContext(base);
    expect(md).toContain('role:routing');
    expect(md).toContain('goes through the service layer');
    expect(md).toContain('80%');
    expect(md).toContain('src/routes/a.ts');
  });

  it('says so when a group has no convention rather than inventing one', () => {
    const md = renderContext({
      ...base,
      votes: [vote({ dominant: null, reason: 'no_convention' })],
    });
    expect(md).toContain('have **no** convention');
    expect(md).toContain('rather than copying the nearest file');
  });

  it('reports having found no convention at all without crashing', () => {
    const md = renderContext({ ...base, votes: [] });
    expect(md).toContain('No peer group was consistent enough');
  });

  it('marks a protected finding as unwaivable', () => {
    const md = renderContext({
      ...base,
      receipt: receipt({
        counts: { architecture: 0, security: 1, protected: 1, unknowns: 0 },
        findings: {
          architecture_findings: [],
          security_findings: [
            {
              id: 'sec-01',
              kind: 'unguarded_entrypoint',
              claim: 'No guard.',
              remediation: 'Add one.',
              protected_finding: true,
            },
          ],
        },
      } as unknown as Partial<ReviewReceipt>),
    });
    expect(md).toContain('(protected — cannot be waived)');
  });

  it('carries the no-certification disclaimer', () => {
    expect(renderContext(base)).toContain('absence of findings is not a certification');
  });

  it('handles a clean review', () => {
    const md = renderContext({
      ...base,
      receipt: receipt({
        decision: 'pass',
        counts: { architecture: 0, security: 0, protected: 0, unknowns: 0 },
        findings: { architecture_findings: [], security_findings: [] },
      } as unknown as Partial<ReviewReceipt>),
    });
    expect(md).toContain('Decision: `pass`');
    expect(md).toContain('None.');
  });
});

describe('injectContextBlock', () => {
  it('appends a managed block to a file that has none', () => {
    const result = injectContextBlock('# My rules\n\nAlways run tests.\n', 'BODY');
    expect(result).toContain('Always run tests.');
    expect(result).toContain(BLOCK_START);
    expect(result).toContain('BODY');
    expect(result).toContain(BLOCK_END);
  });

  it('replaces an existing block in place, leaving human text alone', () => {
    const first = injectContextBlock('# Mine\n\nKeep me.\n', 'OLD BODY');
    const second = injectContextBlock(first, 'NEW BODY');
    expect(second).toContain('Keep me.');
    expect(second).toContain('NEW BODY');
    expect(second).not.toContain('OLD BODY');
  });

  it('is idempotent — repeated runs never stack blocks', () => {
    let text = '# Mine\n';
    for (let i = 0; i < 5; i++) text = injectContextBlock(text, 'BODY');
    expect(text.split(BLOCK_START)).toHaveLength(2);
    expect(text.split(BLOCK_END)).toHaveLength(2);
  });

  it('preserves text written after the block', () => {
    const withTrailer = `${injectContextBlock('# Mine\n', 'OLD')}\n## My own section\n\nMore.\n`;
    const updated = injectContextBlock(withTrailer, 'NEW');
    expect(updated).toContain('## My own section');
    expect(updated).toContain('NEW');
    expect(updated).not.toContain('OLD');
  });

  it('handles an empty starting file', () => {
    expect(injectContextBlock('', 'BODY')).toContain('BODY');
  });
});
