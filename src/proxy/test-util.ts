/**
 * Test scaffolding for the proxy suites: a hermetic context dir, a fake
 * upstream `fetch`, and `startTestProxy` (port 0, fallback deps unless
 * overridden). Not part of the public surface.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveProxyConfig, type ProxyConfig } from './config.js';
import { startProxy, type RunningProxy, type StartProxyDeps } from './server.js';

export function tempEnv(extra: Record<string, string> = {}): { env: NodeJS.ProcessEnv; dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-proxy-'));
  const env: NodeJS.ProcessEnv = { VG_CONTEXT_DIR: path.join(dir, 'context'), VG_CONTEXT_RUNTIME_DIR: path.join(dir, 'run'), VG_PROXY_PORT: '0', VG_PROXY_SKIP_UPSTREAM_CHECK: 'true', HOME: dir, ...extra };
  return { env, dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

export interface FakeCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | string | null;
}

export type FakeHandler = (call: FakeCall, index: number) => Response | Promise<Response>;

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'request-id': 'req_fake', ...headers } });
}

export function sseResponse(frames: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) controller.enqueue(encoder.encode(f));
      controller.close();
    },
  });
  return new Response(stream, { status, headers: { 'content-type': 'text/event-stream' } });
}

export function fakeUpstream(handler: FakeHandler): { fetch: typeof fetch; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const f: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers ?? {}).forEach((v, k) => (headers[k] = v));
    let body: FakeCall['body'] = null;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body) as Record<string, unknown>;
      } catch {
        body = init.body;
      }
    } else if (init?.body instanceof Uint8Array) {
      const text = Buffer.from(init.body).toString('utf8');
      try {
        body = JSON.parse(text) as Record<string, unknown>;
      } catch {
        body = text;
      }
    }
    const call: FakeCall = { url, method: (init?.method ?? 'GET').toUpperCase(), headers, body };
    calls.push(call);
    return handler(call, calls.length - 1);
  };
  return { fetch: f, calls };
}

export function anthropicReply(text: string, usage: Record<string, number> = { input_tokens: 40, output_tokens: 12 }): Record<string, unknown> {
  return { id: 'msg_01', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage };
}

export function anthropicSseFrames(text: string, usage: Record<string, number> = { input_tokens: 40, output_tokens: 12 }): string[] {
  const f = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  return [
    f('message_start', { type: 'message_start', message: { id: 'msg_01', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content: [], usage: { input_tokens: usage.input_tokens, output_tokens: 0 } } }),
    f('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    f('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(0, 3) } }),
    f('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(3) } }),
    f('content_block_stop', { type: 'content_block_stop', index: 0 }),
    f('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: usage.output_tokens } }),
    f('message_stop', { type: 'message_stop' }),
  ];
}

export interface TestProxy {
  proxy: RunningProxy;
  url: string;
  config: ProxyConfig;
  env: NodeJS.ProcessEnv;
  dir: string;
  close: () => Promise<void>;
}

export async function startTestProxy(opts: { env?: Record<string, string>; overrides?: Partial<ProxyConfig>; deps?: StartProxyDeps } = {}): Promise<TestProxy> {
  const t = tempEnv(opts.env);
  const config = resolveProxyConfig({ port: 0, ...opts.overrides }, t.env);
  const proxy = await startProxy(config, { bindModules: false, baseEnv: {}, ...opts.deps });
  return {
    proxy,
    url: proxy.url,
    config: proxy.context.config,
    env: t.env,
    dir: t.dir,
    close: async () => {
      await proxy.close();
      t.cleanup();
    },
  };
}

/** `fetch` against the test proxy with JSON conveniences. */
export async function call(url: string, path: string, init: RequestInit & { json?: unknown } = {}): Promise<{ status: number; headers: Headers; text: string; json: Record<string, unknown> | null }> {
  const headers = new Headers(init.headers ?? {});
  let body = init.body;
  if (init.json !== undefined) {
    body = JSON.stringify(init.json);
    if (!headers.has('content-type')) headers.set('content-type', 'application/json');
  }
  const res = await fetch(`${url}${path}`, { ...init, headers, body });
  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = null;
  }
  return { status: res.status, headers: res.headers, text, json };
}
