import { describe, expect, it } from 'vitest';
import { architecturePageHtml } from './page.js';

describe('architecturePageHtml', () => {
  it('falls back without HAILE and never names the kernel', () => {
    const html = architecturePageHtml(null, { host: 'browser' });
    expect(html).toContain('Code map');
    expect(html).toContain('data-host="browser"');
    expect(html).not.toMatch(/HAILE/i);
    expect(html).not.toContain('function sizeMap(');
  });

  it('binds a vscode host and nonce for the editor webview', () => {
    const html = architecturePageHtml(null, { host: 'vscode', nonce: 'abc+123=' });
    expect(html).toContain('data-host="vscode"');
    expect(html).toContain('nonce="abc+123="');
    expect(html).toContain('acquireVsCodeApi');
    expect(html).toContain('openSlice');
    expect(html).not.toMatch(/HAILE/i);
  });

  it('strips script-breaker characters from the nonce', () => {
    const html = architecturePageHtml(null, { host: 'vscode', nonce: 'ab<script>' });
    expect(html).toContain('nonce="abscript"');
    expect(html).not.toContain('nonce="ab<script>"');
  });
});
