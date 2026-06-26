import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitSections, tokenizeQuery, symbolsFromApi, selectForBudget } from '../src/engine/select.js';
import { truncateToTokens, countTokens } from '../src/engine/tokens.js';

interface CorpusFixture {
  name: string;
  query: string;
  budget?: number;
  readme: string;
  critical: string[];
  noise?: string[];
  criticalAtTop?: boolean;
}

/** A realistic README: badges + TOC + install up front, the critical Usage buried late. */
function acmeReadme(): string {
  return [
    '# acme-client',
    '![build](https://img.shields.io/badge/build-passing-green) ![coverage](https://img.shields.io/badge/cov-99-green) ![npm](https://img.shields.io/npm/v/acme.svg)',
    '## Table of Contents',
    '- [Installation](#installation)\n- [Usage](#usage)\n- [License](#license)',
    '## Installation',
    '```sh\nnpm install acme-client\n```',
    ...Array.from({ length: 40 }, (_, i) => `Background prose paragraph ${i}: history, motivation, and philosophy of the project.`),
    '## Usage',
    '```ts\nimport { AcmeClient } from "acme-client";\nconst client = new AcmeClient({ apiKey: "x" });\nawait client.send("/path", { body: {} });\n```',
    '## License',
    'MIT',
  ].join('\n\n');
}

describe('section splitting + features', () => {
  it('splits at ATX headings, preamble is the level-0 section', () => {
    const s = splitSections('intro text\n## Usage\nuse it\n## License\nMIT');
    expect(s.map((x) => x.heading)).toEqual(['', 'Usage', 'License']);
    expect(s[0].body).toBe('intro text');
  });

  it('tokenizes queries (drops stopwords) and extracts API symbols', () => {
    expect(tokenizeQuery('how do I use the Client')).toEqual(['client']);
    expect(symbolsFromApi('export function createClient(): void;\nexport class Logger {}')).toEqual(['createClient', 'Logger']);
  });
});

describe('selectForBudget — beats prefix truncation on the critical chunk', () => {
  const readme = acmeReadme();
  const query = 'create a client and send a request';
  const budget = 120;

  it('PROOF: prefix truncation misses the buried Usage; the selector keeps it', () => {
    const prefix = truncateToTokens(readme, budget).text;
    expect(prefix).not.toContain('client.send('); // naive top-N misses it

    const selected = selectForBudget({ readme, query, budget }).text;
    expect(selected).toContain('client.send(');
    expect(selected).toContain('new AcmeClient(');
    expect(countTokens(selected)).toBeLessThanOrEqual(budget);
  });

  it('deprioritises preamble (badges/TOC/install/license) under budget', () => {
    const selected = selectForBudget({ readme, query, budget }).text;
    expect(selected).toContain('Usage');
    expect(selected).not.toContain('Table of Contents');
    expect(selected).not.toContain('shields.io'); // badge block dropped
  });

  it('ORDERING FIX: the API surface leads and survives a tiny budget', () => {
    const selected = selectForBudget({
      readme,
      apiSurface: 'export function connect(url: string): Promise<void>;',
      budget: 30,
    }).text;
    expect(selected).toContain('export function connect'); // not appended-then-truncated away
    expect(countTokens(selected)).toBeLessThanOrEqual(30);
  });

  it('unbudgeted returns the full doc (README + API), no reordering', () => {
    const r = selectForBudget({ readme: '# x\nhello', apiSurface: 'export const V: string;' });
    expect(r.truncated).toBe(false);
    expect(r.text).toContain('hello');
    expect(r.text).toContain('export const V');
  });
});

describe('recall@budget across a small fixture set (the harness metric)', () => {
  // Each fixture: a README with preamble + a buried critical section, and the
  // markers a good selection must contain. (The real tuner runs this over 10k.)
  const fixtures = [
    {
      query: 'create a client and send',
      readme: acmeReadme(),
      markers: ['new AcmeClient(', 'client.send('],
    },
    {
      query: 'format a date',
      readme: [
        '# datelib',
        '![ci](https://x/ci.svg)',
        '## Installation',
        '```sh\nnpm i datelib\n```',
        ...Array.from({ length: 30 }, (_, i) => `Filler ${i}: rationale and comparisons with other libraries.`),
        '## Usage',
        '```ts\nimport { format } from "datelib";\nformat(new Date(), "yyyy-MM-dd");\n```',
        '## Contributing',
        'PRs welcome',
      ].join('\n\n'),
      markers: ['format(new Date('],
    },
  ];

  const recall = (selector: (q: string, md: string, b: number) => string): number => {
    let hit = 0;
    let total = 0;
    for (const f of fixtures) {
      const out = selector(f.query, f.readme, 120);
      for (const m of f.markers) {
        total++;
        if (out.includes(m)) hit++;
      }
    }
    return hit / total;
  };

  it('the selector recalls the critical markers; prefix truncation does not', () => {
    const prefixRecall = recall((_q, md, b) => truncateToTokens(md, b).text);
    const selectorRecall = recall((q, md, b) => selectForBudget({ readme: md, query: q, budget: b }).text);
    expect(prefixRecall).toBeLessThan(0.5); // naive baseline misses buried chunks
    expect(selectorRecall).toBe(1); // selector finds them all
    expect(selectorRecall).toBeGreaterThan(prefixRecall);
  });
});

describe('hardened eval — corpus-driven invariants', () => {
  const corpusPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'selection-corpus.json');
  const corpus = JSON.parse(fs.readFileSync(corpusPath, 'utf8')) as CorpusFixture[];
  const B = (f: CorpusFixture): number => f.budget ?? 120;

  it('the corpus is diverse', () => {
    expect(corpus.length).toBeGreaterThanOrEqual(8);
    expect(new Set(corpus.map((f) => f.name)).size).toBe(corpus.length);
  });

  for (const f of corpus) {
    it(`[${f.name}] recall=1 · no noise leak · within budget · deterministic`, () => {
      const r1 = selectForBudget({ readme: f.readme, query: f.query, budget: B(f) });
      const r2 = selectForBudget({ readme: f.readme, query: f.query, budget: B(f) });
      expect(r1.text).toBe(r2.text); // deterministic
      expect(r1.tokens).toBeLessThanOrEqual(B(f)); // budget adherence
      for (const m of f.critical) expect(r1.text).toContain(m); // recall
      for (const m of f.noise ?? []) expect(r1.text).not.toContain(m); // no noise leak
      if (f.criticalAtTop) {
        const pre = truncateToTokens(f.readme, B(f)).text; // easy case → prefix also gets it (no regression)
        for (const m of f.critical) expect(pre).toContain(m);
      }
    });
  }

  it('AGGREGATE: selector recall = 100% and beats prefix truncation', () => {
    const recall = (fn: (f: CorpusFixture) => string): number => {
      let hit = 0;
      let tot = 0;
      for (const f of corpus) {
        const out = fn(f);
        for (const m of f.critical) {
          tot++;
          if (out.includes(m)) hit++;
        }
      }
      return tot ? hit / tot : 1;
    };
    const prefixR = recall((f) => truncateToTokens(f.readme, B(f)).text);
    const selR = recall((f) => selectForBudget({ readme: f.readme, query: f.query, budget: B(f) }).text);
    expect(selR).toBe(1);
    expect(selR).toBeGreaterThan(prefixR);
  });

  it('a short README under budget is returned whole (not truncated)', () => {
    const short = corpus.find((f) => f.name === 'short-readme');
    expect(short).toBeTruthy();
    expect(selectForBudget({ readme: short!.readme, query: short!.query, budget: B(short!) }).truncated).toBe(false);
  });
});
