import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { CaptureWriter, bodyDigest, captureExchange, compareCaptures, pathKey, readCaptureFile, routeKey, sanitizeHeaders, sanitizeUrl, MAX_BODY_PREVIEW_CHARS } from './capture.js';

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'vg-capture-'));

describe('capture redaction', () => {
  it('masks sensitive headers by name and credential shapes by value; keys are lower-cased and sorted', () => {
    expect(sanitizeHeaders({ Authorization: 'Bearer sk-ant-abcdefghijklmnop', 'X-Api-Key': 'k', 'x-github-token': 't', Cookie: 'a=b', 'Content-Type': 'application/json', 'X-Note': 'token=abcdefghijklmnopqrs' })).toEqual({
      authorization: '***redacted***',
      'content-type': 'application/json',
      cookie: '***redacted***',
      'x-api-key': '***redacted***',
      'x-github-token': '***redacted***',
      'x-note': 'token:***redacted***',
    });
    expect(sanitizeHeaders({ 'Set-Cookie': ['a', 'b'] })).toEqual({ 'set-cookie': '***redacted***' });
  });

  it('masks sensitive query parameters and URL credentials, keeps everything else verbatim', () => {
    const u = sanitizeUrl('https://user:pw@api.example.com/v1/chat?model=x&api_key=abc&code=1&signature=s');
    expect(u.host).toBe('api.example.com');
    expect(u.path).toBe('/v1/chat');
    expect(u.url).toBe('https://user:***redacted***@api.example.com/v1/chat?model=x&api_key=***redacted***&code=***redacted***&signature=***redacted***');
    expect(sanitizeUrl('not a url ghp_abcdefghijklmnop').url).toBe('not a url ghp-***redacted***');
  });

  it('bodies become sha256 + size + a bounded, redacted preview', () => {
    const body = `${'x'.repeat(2000)} OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz`;
    const d = bodyDigest(body);
    expect(d.sha256).toBe(createHash('sha256').update(body).digest('hex'));
    expect(d.size).toBe(Buffer.byteLength(body));
    expect(d.preview!.length).toBeLessThanOrEqual(MAX_BODY_PREVIEW_CHARS);
    const short = bodyDigest('{"key":"sk-abcdefghijklmnopqrstuvwxyz"}');
    expect(short.preview).not.toContain('abcdefghijklmnopqrstuvwxyz');
    expect(bodyDigest(null)).toEqual({ sha256: null, size: 0, preview: null });
    expect(bodyDigest(new Uint8Array([104, 105])).preview).toBe('hi');
  });

  it('captureExchange is pure and deterministic; keys are stable', () => {
    const input = { lane: 'wrapped' as const, sequence: 1, method: 'post', url: 'https://api.anthropic.com/v1/messages?key=1', requestHeaders: { 'x-api-key': 'sk' }, requestBody: '{"model":"m"}', responseStatus: 200, responseHeaders: { 'request-id': 'r' }, responseBody: '{"ok":1}', tokensBefore: 10, tokensAfter: 4, model: 'm', ts: 7 };
    const a = captureExchange(input);
    expect(a).toEqual(captureExchange(input));
    expect(a).toMatchObject({ kind: 'exchange', lane: 'wrapped', sequence: 1, ts: 7, method: 'POST', host: 'api.anthropic.com', path: '/v1/messages', url: 'https://api.anthropic.com/v1/messages?key=***redacted***', requestHeaders: { 'x-api-key': '***redacted***' }, responseStatus: 200, responseHeaders: { 'request-id': 'r' }, requestBodySize: 13, requestBodyPreview: '{"model":"m"}', responseBodySize: 8, tokensBefore: 10, tokensAfter: 4, model: 'm' });
    expect(routeKey(a)).toBe('POST api.anthropic.com/v1/messages');
    expect(pathKey(a)).toBe('POST /v1/messages');
  });
});

describe('CaptureWriter + compare', () => {
  it('writes JSONL (0600), reads it back, and pairs lanes by path or route', () => {
    const dir = tmp();
    const direct = path.join(dir, 'direct.jsonl');
    const wrapped = path.join(dir, 'wrapped.jsonl');
    const wd = new CaptureWriter(direct);
    const ww = new CaptureWriter(wrapped);
    expect(fs.statSync(direct).mode & 0o777).toBe(0o600);
    wd.session('start', { ts: 1, agent: 'claude', proxyUrl: '' });
    wd.exchange({ lane: 'direct', method: 'POST', url: 'https://api.anthropic.com/v1/messages', requestBody: 'big body here' });
    wd.exchange({ lane: 'direct', method: 'GET', url: 'https://api.anthropic.com/v1/models' });
    ww.exchange({ lane: 'wrapped', method: 'POST', url: 'http://127.0.0.1:8787/v1/messages', requestBody: 'small' });
    ww.exchange({ lane: 'wrapped', method: 'POST', url: 'http://127.0.0.1:8787/v1/retrieve' });
    fs.appendFileSync(wrapped, 'garbage line\n');
    const d = readCaptureFile(direct);
    const w = readCaptureFile(wrapped);
    expect(d).toHaveLength(3);
    expect(w).toHaveLength(2);
    expect((w[0] as { sequence: number }).sequence).toBe(1);
    const byPath = compareCaptures(d, w, 'path');
    expect(byPath).toEqual({
      directCount: 2,
      wrappedCount: 2,
      onlyDirect: ['GET /v1/models'],
      onlyWrapped: ['POST /v1/retrieve'],
      paired: [{ key: 'POST /v1/messages', direct: 1, wrapped: 1, requestBytesDirect: 13, requestBytesWrapped: 5, sameBody: false }],
    });
    const byRoute = compareCaptures(d, w, 'route');
    expect(byRoute.paired).toEqual([]);
    expect(byRoute.onlyDirect).toEqual(['GET api.anthropic.com/v1/models', 'POST api.anthropic.com/v1/messages']);
    // Lane fallback for records without one.
    fs.writeFileSync(path.join(dir, 'nolane.jsonl'), `${JSON.stringify({ method: 'GET', url: 'https://x/y', sequence: 1 })}\n`);
    expect((readCaptureFile(path.join(dir, 'nolane.jsonl'), 'direct')[0] as { lane: string }).lane).toBe('direct');
  });
});
