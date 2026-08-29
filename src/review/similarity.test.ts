import { describe, expect, it } from 'vitest';
import {
  LCS_THRESHOLD,
  MIN_CALL_OVERLAP,
  MIN_TOKENS,
  callOverlap,
  SimilarityIndex,
  bandKeys,
  hasSubstance,
  isComparable,
  jaccard,
  lcsRatio,
  minhash,
  normalizeTokens,
  shingles,
  type FunctionBody,
} from './similarity.js';

function body(id: string, text: string, overrides: Partial<FunctionBody> = {}): FunctionBody {
  return { id, name: id, file: `src/${id}.ts`, startLine: 1, endLine: 20, text, ...overrides };
}

/** The same logic, written twice with different names — the target case. */
const ORIGINAL = `
function calculateInvoiceTotal(items, taxRate) {
  let total = 0;
  for (const item of items) {
    total = total + item.price * item.quantity;
  }
  const tax = total * taxRate;
  return round(total + tax, 2);
}`;

const RENAMED_COPY = `
function computeBillSum(lines, vatPercent) {
  let sum = 0;
  for (const line of lines) {
    sum = sum + line.price * line.quantity;
  }
  const vat = sum * vatPercent;
  return round(sum + vat, 2);
}`;

const GENUINELY_DIFFERENT = `
function sendWelcomeEmail(user, template) {
  if (!user.email) {
    throw new Error("no address");
  }
  const rendered = renderTemplate(template, user);
  return mailer.deliver(user.email, rendered);
}`;

// ── normalization ───────────────────────────────────────────────────────────

describe('normalizeTokens', () => {
  it('collapses local identifiers but keeps call names', () => {
    const tokens = normalizeTokens('const x = doTheThing(y);');
    expect(tokens).toContain('CALL:doTheThing');
    expect(tokens).toContain('ID');
    expect(tokens).not.toContain('doTheThing');
  });

  it('erases literals so different constants do not look like different logic', () => {
    expect(normalizeTokens('f(1)')).toEqual(normalizeTokens('f(999)'));
    expect(normalizeTokens('f("a")')).toEqual(normalizeTokens('f("zzz")'));
  });

  it('strips comments', () => {
    expect(normalizeTokens('// explain\nf(x)')).toEqual(normalizeTokens('f(x)'));
    expect(normalizeTokens('/* block */ f(x)')).toEqual(normalizeTokens('f(x)'));
  });

  it('keeps control-flow keywords, which carry the shape', () => {
    expect(normalizeTokens('if (a) { return b; }')).toContain('if');
    expect(normalizeTokens('if (a) { return b; }')).toContain('return');
  });

  it('makes a renamed copy normalize identically', () => {
    expect(normalizeTokens(ORIGINAL)).toEqual(normalizeTokens(RENAMED_COPY));
  });

  it('keeps genuinely different logic different', () => {
    expect(normalizeTokens(ORIGINAL)).not.toEqual(normalizeTokens(GENUINELY_DIFFERENT));
  });
});

// ── MinHash / LSH ───────────────────────────────────────────────────────────

describe('minhash', () => {
  it('is deterministic — the same input always gives the same signature', () => {
    // The receipt must stay byte-stable, so nothing here may use a clock or RNG.
    expect(minhash(shingles(normalizeTokens(ORIGINAL)))).toEqual(
      minhash(shingles(normalizeTokens(ORIGINAL))),
    );
  });

  it('estimates high similarity for a renamed copy', () => {
    const a = minhash(shingles(normalizeTokens(ORIGINAL)));
    const b = minhash(shingles(normalizeTokens(RENAMED_COPY)));
    expect(jaccard(a, b)).toBeGreaterThan(0.9);
  });

  it('estimates low similarity for different logic', () => {
    const a = minhash(shingles(normalizeTokens(ORIGINAL)));
    const b = minhash(shingles(normalizeTokens(GENUINELY_DIFFERENT)));
    expect(jaccard(a, b)).toBeLessThan(0.5);
  });

  it('produces one band key per band', () => {
    expect(bandKeys(minhash(shingles(normalizeTokens(ORIGINAL))))).toHaveLength(16);
  });

  it('gives identical bodies identical band keys', () => {
    const a = bandKeys(minhash(shingles(normalizeTokens(ORIGINAL))));
    const b = bandKeys(minhash(shingles(normalizeTokens(RENAMED_COPY))));
    expect(a.some((k) => b.includes(k))).toBe(true);
  });
});

describe('shingles', () => {
  it('produces contiguous k-token windows', () => {
    expect(shingles(['a', 'b', 'c', 'd'], 2)).toEqual(['a b', 'b c', 'c d']);
  });

  it('degrades to a single shingle for a short body rather than returning nothing', () => {
    expect(shingles(['a', 'b'], 5)).toEqual(['a b']);
  });

  it('returns nothing for an empty token list', () => {
    expect(shingles([], 5)).toEqual([]);
  });
});

// ── LCS ─────────────────────────────────────────────────────────────────────

describe('lcsRatio', () => {
  it('is 1 for identical sequences', () => {
    expect(lcsRatio(['a', 'b', 'c'], ['a', 'b', 'c'])).toBe(1);
  });

  it('is 0 for disjoint sequences', () => {
    expect(lcsRatio(['a', 'b'], ['x', 'y'])).toBe(0);
  });

  it('is order-sensitive where Jaccard is not', () => {
    // Same vocabulary, reversed order. A set-based measure calls this identical;
    // LCS is what rejects it, which is why it is the deciding check.
    const forward = ['a', 'b', 'c', 'd'];
    const reversed = ['d', 'c', 'b', 'a'];
    expect(lcsRatio(forward, reversed)).toBeLessThan(0.5);
  });

  it('handles an empty side without dividing by zero', () => {
    expect(lcsRatio([], ['a'])).toBe(0);
    expect(lcsRatio(['a'], [])).toBe(0);
  });

  it('stays bounded on a very long body', () => {
    const long = Array.from({ length: 5000 }, (_, i) => `t${i % 40}`);
    const started = Date.now();
    expect(lcsRatio(long, long)).toBeGreaterThan(0);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

// ── the index ───────────────────────────────────────────────────────────────

describe('SimilarityIndex', () => {
  it('finds a renamed re-implementation', () => {
    const index = new SimilarityIndex();
    index.add(body('original', ORIGINAL));
    index.add(body('unrelated', GENUINELY_DIFFERENT));

    const hits = index.find(body('copy', RENAMED_COPY));
    expect(hits).toHaveLength(1);
    expect(hits[0].id).toBe('original');
    expect(hits[0].score).toBeGreaterThan(LCS_THRESHOLD);
  });

  it('does not report genuinely different logic', () => {
    const index = new SimilarityIndex();
    index.add(body('original', ORIGINAL));
    expect(index.find(body('other', GENUINELY_DIFFERENT))).toEqual([]);
  });

  it('never matches a body against itself', () => {
    const index = new SimilarityIndex();
    index.add(body('same', ORIGINAL));
    expect(index.find(body('same', ORIGINAL))).toEqual([]);
  });

  it('honours the exclusion set', () => {
    const index = new SimilarityIndex();
    index.add(body('original', ORIGINAL));
    expect(index.find(body('copy', RENAMED_COPY), new Set(['original']))).toEqual([]);
  });

  it('ignores bodies too short to have a meaningful shape', () => {
    // Every three-line getter matches every other one; reporting that is noise.
    const index = new SimilarityIndex();
    index.add(body('tiny1', 'function a() { return 1; }'));
    expect(index.size).toBe(0);
    expect(index.find(body('tiny2', 'function b() { return 2; }'))).toEqual([]);
    expect(MIN_TOKENS).toBeGreaterThan(5);
  });

  it('ranks the best match first', () => {
    const index = new SimilarityIndex();
    index.add(body('exact', ORIGINAL));
    index.add(
      body('loose', ORIGINAL.replace('const tax = total * taxRate;', 'const tax = compute(total);')),
    );
    const hits = index.find(body('copy', RENAMED_COPY));
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0].id).toBe('exact');
  });

  it('is deterministic across rebuilds', () => {
    const build = (): SimilarityIndex => {
      const i = new SimilarityIndex();
      i.add(body('original', ORIGINAL));
      i.add(body('unrelated', GENUINELY_DIFFERENT));
      return i;
    };
    expect(build().find(body('copy', RENAMED_COPY))).toEqual(build().find(body('copy', RENAMED_COPY)));
  });
});

describe('isComparable', () => {
  it.each([
    ['src/billing/invoice.ts', true],
    ['src/billing/invoice.test.ts', false],
    ['src/__tests__/invoice.ts', false],
    ['test/helpers.ts', false],
    ['vendor/lib/thing.js', false],
    ['dist/bundle.js', false],
    ['src/api.generated.ts', false],
    ['src/lib.min.js', false],
    ['src/types.d.ts', false],
  ])('%s is comparable: %s', (file, expected) => {
    expect(isComparable(file)).toBe(expected);
  });

  it('excludes tests because repetition there is the point', () => {
    // Two tests that set up the same fixture are not a duplication problem.
    expect(isComparable('src/billing/invoice.spec.ts')).toBe(false);
  });
});

// ── thin wrappers are not duplicates ────────────────────────────────────────

describe('hasSubstance', () => {
  it('rejects a one-line delegator despite its token count', () => {
    // Type annotations and punctuation push this past the raw token floor, and
    // every delegator forwarding to the same function then looks identical to
    // every other. A thin wrapper is the intended shape, not a duplication bug.
    const tokens = normalizeTokens('export function routeE(id: string): string { return findE(id); }');
    expect(tokens.length).toBeGreaterThan(MIN_TOKENS);
    expect(hasSubstance(tokens)).toBe(false);
  });

  it('accepts a body with a branch', () => {
    expect(
      hasSubstance(
        normalizeTokens('function f(a: number): number { if (a > 0) { return a; } return -a; }'),
      ),
    ).toBe(true);
  });

  it('accepts a body that calls more than one thing', () => {
    expect(
      hasSubstance(
        normalizeTokens('function f(a: string): string { const b = parse(a); return format(b, a); }'),
      ),
    ).toBe(true);
  });

  it('rejects an empty body', () => {
    expect(hasSubstance(normalizeTokens('function f() {}'))).toBe(false);
  });

  it('keeps the real duplicate case working', () => {
    const index = new SimilarityIndex();
    index.add(body('original', ORIGINAL));
    expect(index.find(body('copy', RENAMED_COPY))).toHaveLength(1);
  });

  it('no longer reports two delegators to the same function as duplicates', () => {
    const index = new SimilarityIndex();
    index.add(body('a', 'export function routeA(id: string): string { return findThing(id); }'));
    expect(index.find(body('b', 'export function routeB(id: string): string { return findThing(id); }'))).toEqual([]);
  });
});

// ── same shape, different work ──────────────────────────────────────────────

describe('callOverlap gate', () => {
  /**
   * Sibling CRUD handlers are the shape every layered codebase has: log,
   * dispatch, 404 or Ok. They score ~0.92 on LCS because their control flow
   * genuinely is identical — but they are not a duplication defect, and
   * reporting them buries the findings that matter.
   */
  const PRODUCTS = `
    public async Task<IActionResult> GetById(int id) {
      _logger.LogInformation("fetching", id);
      var result = await _mediator.Send(new GetProductByIdQuery(id));
      if (result == null) { _logger.LogWarning("missing", id); return NotFound(); }
      return Ok(result);
    }`;
  const ORDERS = `
    public async Task<IActionResult> GetById(int id) {
      _logger.LogInformation("fetching", id);
      var result = await _repository.GetByIdWithItemsAsync(id);
      if (result == null) { _logger.LogWarning("missing", id); return NotFound(); }
      return Ok(MapToDetailDto(result));
    }`;

  it('scores sibling handlers high on structure but low on call vocabulary', () => {
    const a = normalizeTokens(PRODUCTS);
    const b = normalizeTokens(ORDERS);
    expect(lcsRatio(a, b)).toBeGreaterThan(LCS_THRESHOLD);
    // The shared calls are all framework plumbing; the domain calls are disjoint.
    expect(callOverlap(a, b)).toBeLessThan(MIN_CALL_OVERLAP);
  });

  it('does not report sibling handlers as duplicates', () => {
    const index = new SimilarityIndex();
    index.add(body('products', PRODUCTS));
    expect(index.find(body('orders', ORDERS))).toEqual([]);
  });

  it('still reports a genuine copy, which calls the same collaborators', () => {
    expect(callOverlap(normalizeTokens(ORIGINAL), normalizeTokens(RENAMED_COPY))).toBe(1);
    const index = new SimilarityIndex();
    index.add(body('original', ORIGINAL));
    expect(index.find(body('copy', RENAMED_COPY))).toHaveLength(1);
  });

  it('treats two bodies that call nothing as no evidence, not perfect overlap', () => {
    expect(callOverlap(['ID', '=', 'NUM'], ['ID', '=', 'NUM'])).toBe(0);
  });
});
