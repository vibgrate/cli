/**
 * Architecture map HTML. Prefers the Architecture module page; otherwise the
 * tiny host fallback. VS Code injects a nonce for webview CSP.
 */
import type { HaileProvider } from '../haile/haile-provider.js';
import type { ArchPageHost } from './arch-types.js';
import { fallbackArchPage } from './fallback-page.js';

export interface ArchPageOpts {
  host?: ArchPageHost;
  nonce?: string;
}

export function architecturePageHtml(provider: HaileProvider | null, opts: ArchPageOpts = {}): string {
  const host: ArchPageHost = opts.host === 'vscode' ? 'vscode' : 'browser';
  const nonce = sanitizeNonce(opts.nonce);
  if (provider?.renderArchPage) {
    try {
      const html = provider.renderArchPage({ host, nonce: nonce || undefined });
      if (isUsableArchPage(html)) return bindPageNonce(html, nonce);
    } catch {
      /* host fallback */
    }
  }
  return bindPageNonce(fallbackArchPage({ host, nonce }), nonce);
}

function isUsableArchPage(html: unknown): html is string {
  return (
    typeof html === 'string' &&
    html.includes('<html') &&
    html.length > 100 &&
    html.length < 2_000_000 &&
    !/HAILE/i.test(html)
  );
}

function sanitizeNonce(raw: string | undefined): string {
  if (!raw) return '';
  return raw.replace(/[^A-Za-z0-9+/=_-]/g, '').slice(0, 64);
}

function bindPageNonce(html: string, nonce: string): string {
  let out = html.replace(/\{\{NONCE\}\}/g, nonce);
  if (!nonce) return out.replace(/\snonce=""/g, '');
  return out.replace(/<script\b(?![^>]*\bnonce=)/gi, `<script nonce="${nonce}"`);
}

export { fallbackArchPage as chartPage } from './fallback-page.js';
