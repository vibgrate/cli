import { describe, it, expect } from 'vitest';
import { logoLines, codeLogoLines } from './logo.js';
import { VERSION } from '../version.js';

describe('logo', () => {
  it('renders the graph banner with the version', () => {
    const text = logoLines('myrepo').join('\n');
    expect(text).toContain('Vibgrate');
    expect(text).toContain(`v${VERSION}`);
    expect(text).toContain('myrepo');
  });

  it('renders the VG Code banner (approved marketing name) with the version', () => {
    const text = codeLogoLines('myrepo').join('\n');
    // "VG" and "Code" appear (colour codes may sit between them, so check separately).
    expect(text).toContain('VG');
    expect(text).toContain('Code');
    expect(text).toContain(`v${VERSION}`);
  });
});
