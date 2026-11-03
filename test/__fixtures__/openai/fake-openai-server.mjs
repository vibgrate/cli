#!/usr/bin/env node
/**
 * Scripted OpenAI-compatible chat server for driving the NATIVE `vg code`
 * loop end to end without a model (e.g. `--provider lmstudio` with
 * LMSTUDIO_BASE_URL pointed here). A SIMULATION for harness testing: numbers
 * measured against it describe the harness, not any model.
 *
 * Usage: node fake-openai-server.mjs <script.json> [port]   (prints "listening <port>")
 *
 * Script: { "delayMs": 0, "byPrompt": [ { "match": "regex", "steps": [ step, … ] } ] }
 * The step served is chosen by how many assistant turns the request already
 * carries (step 0 for the first call, …); the last step repeats.
 * step: { "content": "text" } | { "tool_calls": [ { "name": "read_file", "arguments": { … } } ] }
 */
import * as fs from 'node:fs';
import * as http from 'node:http';

const script = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const port = Number(process.argv[3] ?? 0);
let callId = 0;

function pick(messages) {
  const users = messages.filter((m) => m.role === 'user').map((m) => (typeof m.content === 'string' ? m.content : ''));
  // The native loop's task turn is `Task: …`; match on it so a recap of an
  // earlier turn (session mode) cannot select that turn's script.
  const task = users.find((u) => u.startsWith('Task: ')) ?? users.join('\n');
  const entry = (script.byPrompt ?? []).find((e) => new RegExp(e.match, 'i').test(task)) ?? script.byPrompt?.[0];
  const steps = entry?.steps ?? [{ content: 'done' }];
  // Count assistant turns since the LAST task in this conversation (session mode carries earlier turns as a recap, not as messages).
  const n = messages.filter((m) => m.role === 'assistant').length;
  return steps[Math.min(n, steps.length - 1)];
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && /\/models$/.test(req.url ?? '')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-model', object: 'model' }] }));
    return;
  }
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', async () => {
    const reqJson = JSON.parse(body || '{}');
    const step = pick(reqJson.messages ?? []);
    if (script.delayMs) await new Promise((r) => setTimeout(r, script.delayMs));
    const toolCalls = (step.tool_calls ?? []).map((t) => ({
      id: `call_${++callId}`,
      type: 'function',
      function: { name: t.name, arguments: JSON.stringify(t.arguments ?? {}) },
    }));
    const usage = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 };
    if (reqJson.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (delta, finish = null) =>
        res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', model: reqJson.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
      if (step.content) for (const piece of step.content.match(/.{1,16}/gs) ?? []) chunk({ content: piece });
      toolCalls.forEach((tc, index) => chunk({ tool_calls: [{ index, id: tc.id, type: 'function', function: tc.function }] }));
      chunk({}, toolCalls.length ? 'tool_calls' : 'stop');
      res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', model: reqJson.model, choices: [], usage })}\n\n`);
      res.end('data: [DONE]\n\n');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'x',
        object: 'chat.completion',
        model: reqJson.model,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: step.content ?? null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
            finish_reason: toolCalls.length ? 'tool_calls' : 'stop',
          },
        ],
        usage,
      }),
    );
  });
});
server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`listening ${server.address().port}\n`);
});
