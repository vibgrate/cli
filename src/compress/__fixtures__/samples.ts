/** Golden fixture generators (seeded, deterministic) shared by the compressor tests. */

export function jsonLogRows(n = 120, errorAt = 67): Array<Record<string, unknown>> {
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    level: i === errorAt ? 'error' : 'info',
    message: i === errorAt ? 'Database connection timeout after 30s (code=ETIMEDOUT)' : `Request handled for /api/v1/users/${i % 7} in ${(i * 13) % 200}ms`,
    ts: `2026-09-02T14:${String(i % 60).padStart(2, '0')}:00Z`,
    service: ['api', 'worker', 'db'][i % 3],
  }));
}

export function pytestLog(n = 300): string {
  const lines: string[] = ['============================= test session starts =============================', 'collected 120 items'];
  for (let i = 0; i < n; i++) {
    if (i === 150) {
      lines.push('tests/test_db.py::test_connect FAILED [ 50%]');
      lines.push('Traceback (most recent call last):');
      lines.push('  File "tests/test_db.py", line 42, in test_connect');
      lines.push('    conn = connect(timeout=30)');
      lines.push('  File "/usr/lib/python3.12/site-packages/psycopg/__init__.py", line 88, in connect');
      lines.push('    raise OperationalError("connection refused")');
      lines.push('OperationalError: connection refused');
    } else if (i % 97 === 0) lines.push(`WARNING deprecated API used in module_${i % 5} (call #${i})`);
    else lines.push(`tests/test_mod_${i % 12}.py::test_case_${i} PASSED [ ${Math.min(99, Math.trunc((i / n) * 100))}%]`);
  }
  lines.push('=========================== 1 failed, 299 passed in 12.34s ===========================');
  return lines.join('\n');
}

export function grepOutput(files = 6, perFile = 12): string {
  const out: string[] = [];
  for (let f = 0; f < files; f++) {
    for (let i = 0; i < perFile; i++) {
      const line = 10 + i * 7;
      const body = i === 5 ? `  throw new Error('failed to load user ${f}')` : `  const value${i} = compute(${f}, ${i});`;
      out.push(`src/module${f}/handler.ts:${line}:${body}`);
    }
  }
  return out.join('\n');
}

export function unifiedDiff(files = 3, hunks = 12, ctx = 6): string {
  const out: string[] = ['commit 0123456789abcdef0123456789abcdef01234567', 'Author: dev <dev@example.com>', ''];
  for (let f = 0; f < files; f++) {
    out.push(`diff --git a/src/file${f}.ts b/src/file${f}.ts`);
    out.push(`index ${'a'.repeat(7)}${f}..${'b'.repeat(7)}${f} 100644`);
    out.push(`--- a/src/file${f}.ts`);
    out.push(`+++ b/src/file${f}.ts`);
    for (let h = 0; h < hunks; h++) {
      const start = 1 + h * 40;
      out.push(`@@ -${start},${ctx * 2 + 2} +${start},${ctx * 2 + 3} @@ function block${h}()`);
      for (let c = 0; c < ctx; c++) out.push(` context before ${h} line ${c}`);
      out.push(`-  const old${h} = ${h};`);
      out.push(`+  const new${h} = ${h} + 1;`);
      out.push(`+  log('changed ${h}');`);
      for (let c = 0; c < ctx; c++) out.push(` context after ${h} line ${c}`);
    }
  }
  return out.join('\n');
}

export const HTML_PAGE = `<!DOCTYPE html>
<html><head><title>Release notes &amp; changes</title><meta charset="utf-8"><style>body{color:red}</style><script>var x = 1;</script></head>
<body>
<nav><ul><li><a href="/">Home</a></li><li><a href="/docs">Docs</a></li></ul></nav>
<header><h1>Site header</h1></header>
<main>
<article>
<h1>Version 2.1.0</h1>
<p>This release fixes the <strong>timeout</strong> bug reported in <a href="https://example.com/issues/42">issue #42</a>.</p>
<ul><li>Faster startup</li><li>Lower memory &lt;usage&gt;</li></ul>
<table><tr><th>Metric</th><th>Before</th><th>After</th></tr><tr><td>Startup</td><td>1200ms</td><td>300ms</td></tr></table>
<pre><code>vg scan --format sarif</code></pre>
</article>
</main>
<aside>Related links and ads</aside>
<footer>&copy; 2026 Example</footer>
</body></html>`;

export const TS_SOURCE = `import { readFileSync } from 'node:fs';
import type { Config } from './config';

export interface Options {
  verbose: boolean;
  retries: number;
}

export function loadConfig(path: string): Config {
  const raw = readFileSync(path, 'utf8');
  const parsed = JSON.parse(raw) as Config;
  if (!parsed.name) {
    throw new Error('missing name');
  }
  const normalized = { ...parsed };
  normalized.name = normalized.name.trim();
  normalized.tags = (normalized.tags ?? []).map((t) => t.toLowerCase());
  normalized.retries = Math.max(0, normalized.retries ?? 3);
  normalized.timeout = normalized.timeout ?? 1000;
  normalized.verbose = Boolean(normalized.verbose);
  return normalized;
}

export function retry<T>(fn: () => T, opts: Options): T {
  let last: unknown;
  for (let i = 0; i < opts.retries; i++) {
    try {
      return fn();
    } catch (err) {
      last = err;
      if (opts.verbose) {
        console.log('retry', i, err);
      }
    }
  }
  const message = last instanceof Error ? last.message : String(last);
  const wrapped = new Error(\`retry failed: \${message}\`);
  throw wrapped;
}

function helper(a: number, b: number): number {
  const sum = a + b;
  const product = a * b;
  const diff = a - b;
  const ratio = b === 0 ? 0 : a / b;
  const mixed = sum + product - diff + ratio;
  return mixed;
}

export const VERSION = '1.0.0';
`;

export const PY_SOURCE = `import os
import sys
from typing import List


class Loader:
    """Loads things."""

    def __init__(self, root: str) -> None:
        self.root = root
        self.cache = {}

    def load(self, name: str) -> List[str]:
        """Load a file by name.

        Long description of the loading process that spans
        several lines of documentation.
        """
        path = os.path.join(self.root, name)
        if path in self.cache:
            return self.cache[path]
        with open(path) as fh:
            lines = fh.read().splitlines()
        cleaned = [l.strip() for l in lines if l.strip()]
        self.cache[path] = cleaned
        return cleaned


def main(argv: List[str]) -> int:
    loader = Loader(argv[1])
    total = 0
    for name in argv[2:]:
        lines = loader.load(name)
        total += len(lines)
        print(name, len(lines))
    print("total", total)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
`;

export const YAML_CONFIG = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  labels:
    app: web
spec:
  replicas: 3
  template:
    spec:
      containers:
        - name: web
          image: web:1.0
          ports:
            - containerPort: 8080
          env:
            - name: LOG_LEVEL
              value: info
        - name: sidecar
          image: sidecar:1.0
          ports:
            - containerPort: 8080
          env:
            - name: LOG_LEVEL
              value: info
`;

export const TOML_CONFIG = `[package]
name = "demo"
version = "0.1.0"
edition = "2021"

# runtime dependencies
[dependencies]
serde = "1.0"
tokio = "1.0"

[[bin]]
name = "one"
path = "src/one.rs"

[[bin]]
name = "two"
path = "src/two.rs"

[[bin]]
name = "three"
path = "src/three.rs"
`;

export function prose(n = 40): string {
  return Array.from({ length: n }, (_, i) => `Paragraph ${i} explains that the deployment pipeline must not skip the integration tests. It also notes build ${i} finished in ${i * 3}s with no regressions.`).join(' ');
}

export function csvTable(rows = 40): string {
  const out = ['id,name,status,latency_ms'];
  for (let i = 0; i < rows; i++) out.push(`${i + 1},svc-${i % 5},${i === 17 ? 'error' : 'ok'},${(i * 37) % 500}`);
  return out.join('\n');
}
