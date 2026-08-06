import { describe, it, expect } from 'vitest';
import { htmlToReadableText, webFetch } from './web-tools.js';

describe('htmlToReadableText', () => {
  it('strips scripts and tags', () => {
    const t = htmlToReadableText('<html><script>x()</script><p>Hello <b>world</b></p></html>');
    expect(t).toContain('Hello');
    expect(t).toContain('world');
    expect(t).not.toContain('script');
  });
});

describe('webFetch', () => {
  it('refuses non-http URLs', async () => {
    const r = await webFetch('file:///etc/passwd');
    expect(r.ok).toBe(false);
    expect(r.content).toMatch(/valid http/i);
  });

  it('labels content untrusted on success', async () => {
    const r = await webFetch('https://example.com/', {
      enforceNetworkPolicy: false,
      fetchImpl: async () =>
        new Response('<html><body><p>Example Domain</p></body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    });
    expect(r.ok).toBe(true);
    expect(r.content).toContain('UNTRUSTED WEB CONTENT');
    expect(r.content).toContain('Example Domain');
  });
});
