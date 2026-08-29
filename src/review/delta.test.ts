import { describe, expect, it } from 'vitest';
import {
  dependencyHints,
  fileReferencesDest,
  isIntroducedEdge,
  removedDestinations,
} from './delta.js';

describe('dependencyHints', () => {
  it('picks up a relative ESM import', () => {
    const hints = dependencyHints(
      `import { InvoiceRepo } from '../repositories/invoiceRepository.js';\n`,
      'src/api/invoices.ts',
    );
    expect(hints.has('src/repositories/invoicerepository')).toBe(true);
    expect(hints.has('invoicerepository')).toBe(true);
  });

  it('picks up require() and C# using', () => {
    const js = dependencyHints(`const x = require('./db');\n`, 'src/a.js');
    expect([...js].some((h) => h.includes('src/db'))).toBe(true);
    const cs = dependencyHints(`using Acme.Data.Invoices;\n`, 'src/Api/InvoicesController.cs');
    expect(cs.has('acme.data.invoices')).toBe(true);
  });
});

describe('isIntroducedEdge', () => {
  const from = 'src/api/invoices.ts';
  const dest = 'src/repositories/invoiceRepository.ts';
  const alreadyThere = `import { InvoiceRepo } from '../repositories/invoiceRepository.js';\nexport function get() { return InvoiceRepo.all(); }\n`;
  const noImport = `export function get() { return 1; }\n`;
  const newlyAdded = `${alreadyThere}`;

  it('treats every edge on a newly added file as introduced', () => {
    expect(isIntroducedEdge('added', from, dest, undefined)).toBe(true);
  });

  it('does not treat occupancy as introduced — a typo in a handler that already imported the repo', () => {
    expect(isIntroducedEdge('modified', from, dest, alreadyThere)).toBe(false);
  });

  it('treats a newly added import as introduced', () => {
    expect(isIntroducedEdge('modified', from, dest, noImport)).toBe(true);
    expect(fileReferencesDest(newlyAdded, from, dest)).toBe(true);
  });

  it('does not invent a bypass when the base text could not be read', () => {
    expect(isIntroducedEdge('modified', from, dest, undefined)).toBe(false);
  });
});

describe('removedDestinations', () => {
  it('names a relative import that left the file', () => {
    const from = 'src/api/invoices.ts';
    const dest = 'src/repositories/invoiceRepository.ts';
    const before = `import { InvoiceRepo } from '../repositories/invoiceRepository.js';\n`;
    const after = `export function get() { return 1; }\n`;
    expect(removedDestinations(from, before, after, [dest, 'src/api/invoices.ts'])).toEqual([dest]);
  });

  it('does not report occupancy as a removal', () => {
    const from = 'src/api/invoices.ts';
    const dest = 'src/repositories/invoiceRepository.ts';
    const text = `import { InvoiceRepo } from '../repositories/invoiceRepository.js';\n`;
    expect(removedDestinations(from, text, text, [dest])).toEqual([]);
  });
});
