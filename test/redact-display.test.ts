import { describe, it, expect } from 'vitest';
import { redactForDisplay } from '../src/core-open/utils/redact.js';

/**
 * `redactForDisplay` scrubs registry and upload error messages before they are
 * printed or stored on an Error. One row per input shape, and every row is
 * also checked for idempotency, since a message can pass through the helper
 * more than once on its way to the terminal.
 *
 * All tokens below are fake.
 */

interface Row {
  name: string;
  input: string;
  expected: string;
}

const rows: Row[] = [
  {
    name: 'userinfo in a registry URL',
    input: 'https://user:tok@registry.example/pkg',
    expected: 'https://registry.example/pkg',
  },
  {
    name: 'mixed-case Access_Token query key',
    input: 'https://registry.example/pkg?Access_Token=EXAMPLEFAKE1234',
    expected: 'https://registry.example/pkg',
  },
  {
    name: 'mixed-case PRIVATE-TOKEN query key',
    input: 'https://gitlab.example/api/v4/packages?PRIVATE-TOKEN=EXAMPLEFAKE1234',
    expected: 'https://gitlab.example/api/v4/packages',
  },
  {
    name: 'sig dropped, non-secret params kept in order',
    input: 'https://cdn.example/upload?part=1&sig=EXAMPLEFAKE1234&page=2',
    expected: 'https://cdn.example/upload?part=1&page=2',
  },
  {
    name: 'token in a URL fragment',
    input: 'https://host.example/cb#access_token=EXAMPLEFAKE1234',
    expected: 'https://host.example/cb#[REDACTED]',
  },
  {
    name: 'GitHub token inside a sentence',
    input: 'request failed with token ghp_EXAMPLEEXAMPLEEXAMPLE, check scopes',
    expected: 'request failed with token [REDACTED], check scopes',
  },
  {
    name: 'npm token inside a sentence',
    input: 'npm rejected npm_EXAMPLEEXAMPLEEXAMPLE for this package',
    expected: 'npm rejected [REDACTED] for this package',
  },
  {
    name: 'GitLab token inside a sentence',
    input: 'GitLab answered 401 for glpat-EXAMPLEEXAMPLE1234 today',
    expected: 'GitLab answered 401 for [REDACTED] today',
  },
  {
    name: 'Authorization: Bearer header',
    input: 'sent Authorization: Bearer EXAMPLEFAKEBEARER1234 and got 403',
    expected: 'sent [REDACTED] and got 403',
  },
  {
    name: 'URL with no secrets is unchanged',
    input: 'https://registry.npmjs.org/@vibgrate%2fcli?page=2&per_page=50#readme',
    expected: 'https://registry.npmjs.org/@vibgrate%2fcli?page=2&per_page=50#readme',
  },
];

describe('redactForDisplay', () => {
  it.each(rows)('$name', ({ input, expected }) => {
    expect(redactForDisplay(input)).toBe(expected);
  });

  it.each(rows)('is idempotent: $name', ({ input }) => {
    const once = redactForDisplay(input);
    expect(redactForDisplay(once)).toBe(once);
  });
});

// Known gaps, recorded rather than fixed here: the helper is vendored from
// @vibgrate/core-open, so the fix belongs upstream. Each case fails today;
// `it.fails` turns red once the upstream fix lands, so flip it to `it` then.
describe('redactForDisplay known gaps', () => {
  // The query key is matched before percent-decoding, so `access%5Ftoken`
  // (`access_token` encoded) is kept, and the token-shape patterns do not
  // match the encoded key either. Today the input comes back unchanged.
  it.fails('drops a percent-encoded credential query key', () => {
    const out = redactForDisplay('https://registry.example/pkg?access%5Ftoken=EXAMPLEFAKE1234&page=2');
    expect(out).not.toContain('EXAMPLEFAKE1234');
  });

  // The query string is taken to run to the end of the text, so in an error
  // sentence everything after a credential parameter is dropped with it.
  // Today this returns 'GET https://registry.example/pkg' and the HTTP status
  // is lost.
  it.fails('keeps the rest of a sentence after a URL with a credential query parameter', () => {
    expect(redactForDisplay('GET https://registry.example/pkg?token=EXAMPLEFAKE1234 failed: 401 Unauthorized')).toBe(
      'GET https://registry.example/pkg failed: 401 Unauthorized',
    );
  });
});
