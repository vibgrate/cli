import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * XL locate fixture: a deterministic, polyglot synthetic repo purpose-built to
 * exercise EVERY search_symbols resolution path against a real built graph —
 * TypeScript, TSX, C#, and Python sources plus JSON config and Markdown docs.
 * No randomness: every file is a pure function of its index, and the returned
 * catalog records the exact file and 1-based line of every symbol and literal,
 * so the locate corpus (locate-corpus.mjs) can assert precise expectations.
 *
 * `scale` is the number of entities per family; total files ≈ 9 × scale + 2.
 * The vitest quality gate uses a small scale; the published bench scales up.
 */

/** Shared literal strings with exact per-repo occurrence counts (one per file
 *  of the carrying family). */
export const SHARED_LITERALS = {
  uiCopy: 'Save your changes now',            // one per component (.tsx)
  logLine: 'failed to reconcile ledger balance', // one per service (.ts)
  unicode: 'Café ☕ Ünïcödé déjà vu',          // one per doc (.md)
  special: '$9.99 (per item) [tax] a|b',      // one per config (.json)
};

class FileBuilder {
  constructor(rel) {
    this.rel = rel;
    this.lines = [];
  }
  /** Append a line; returns its 1-based line number. */
  push(s) {
    this.lines.push(s);
    return this.lines.length;
  }
  write(root, filler) {
    const comment = this.rel.endsWith('.py') ? '#' : '//';
    for (let k = 0; k < filler; k++) this.lines.push(`${comment} filler ${k} — padding so the scanner reads real bytes`);
    const abs = path.join(root, this.rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, this.lines.join('\n') + '\n');
  }
}

/**
 * Generate the repo under a fresh temp dir (or `destRoot` when given — the
 * release-benchmark harness places each arm's copy deterministically). Returns
 * `{ root, scale, catalog }`. `filler` lines are appended AFTER every recorded
 * line so recorded numbers stay exact while file mass is tunable (bench byte
 * volume).
 */
export function generateXlRepo(scale = 4, filler = Number(process.env.BENCH_LINES ?? 10), destRoot = null) {
  let root;
  if (destRoot) {
    root = path.resolve(destRoot);
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true });
  } else {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-xl-'));
  }
  const catalog = {
    scale,
    services: [],    // TS: interface + constant + class + method + function + shared log line
    components: [],  // TSX: component function + shared UI copy
    controllers: [], // C#: controller class + attribute route literal + method
    composes: [],    // C#: registration class + fluent AddJwtBearer-style call (no local definition)
    enums: [],       // C#: same enum name defined in TWO files (the Privilege duplicate shape)
    interfaces: [],  // C#: interface
    python: [],      // Python: class + snake methods/function + constant
    configs: [],     // JSON: dotted config key + shared special-chars literal
    docs: [],        // Markdown: shared unicode literal + per-doc phrase
    hub: null,       // BaseModel defined in both a TS and a C# file
  };

  for (let i = 0; i < scale; i++) {
    // Zero-padded tag: keeps every generated identifier prefix-free at any
    // scale (with bare indices, "AddJwtBearer1" is a substring of
    // "AddJwtBearer10" and literal totals alias across entities).
    const t = String(i).padStart(3, '0');
    // ---- TS service ----
    {
      const f = new FileBuilder(`src/services/OrderService${t}.ts`);
      const ifaceLine = f.push(`export interface OrderRepo${t} {`);
      f.push('  load(id: string): Promise<number>;');
      f.push('}');
      const constLine = f.push(`export const MAX_QUEUE_DEPTH_${t} = ${i + 1};`);
      const classLine = f.push(`export class OrderService${t} {`);
      const methodLine = f.push(`  computeTotal${t}(x: number): number {`);
      const logLine = f.push(`    console.error("${SHARED_LITERALS.logLine}");`);
      f.push(`    return x * ${i + 1};`);
      f.push('  }');
      f.push('}');
      const fnLine = f.push(`export function getUserById${t}(id: string): string {`);
      f.push('  return id;');
      f.push('}');
      f.write(root, filler);
      catalog.services.push({
        file: f.rel,
        iface: { name: `OrderRepo${t}`, line: ifaceLine },
        constant: { name: `MAX_QUEUE_DEPTH_${t}`, line: constLine },
        cls: { name: `OrderService${t}`, line: classLine },
        method: { name: `computeTotal${t}`, line: methodLine },
        fn: { name: `getUserById${t}`, line: fnLine },
        logLine,
      });
    }

    // ---- TSX component ----
    {
      const f = new FileBuilder(`src/components/UserCard${t}.tsx`);
      const compLine = f.push(`export function UserCard${t}(props: { name: string }) {`);
      const copyLine = f.push(`  return <button>${SHARED_LITERALS.uiCopy}</button>;`);
      f.push('}');
      f.write(root, filler);
      catalog.components.push({ file: f.rel, comp: { name: `UserCard${t}`, line: compLine }, copyLine });
    }

    // ---- C# controller with attribute route ----
    {
      const f = new FileBuilder(`src/Api/Controllers/UsersController${t}.cs`);
      f.push('namespace Bridge.Api.Controllers');
      f.push('{');
      f.push('    public class ControllerBase { }');
      const classLine = f.push(`    public class UsersController${t} : ControllerBase`);
      f.push('    {');
      const routeLine = f.push(`        [HttpGet("api/v1/users${t}/mine")]`);
      const methodLine = f.push(`        public string GetTimezoneId${t}()`);
      f.push('        {');
      f.push('            return "GMT Standard Time";');
      f.push('        }');
      f.push('    }');
      f.push('}');
      f.write(root, filler);
      catalog.controllers.push({
        file: f.rel,
        cls: { name: `UsersController${t}`, line: classLine },
        route: { text: `api/v1/users${t}/mine`, line: routeLine },
        method: { name: `GetTimezoneId${t}`, line: methodLine },
      });
    }

    // ---- C# registration with a fluent call whose target is NOT defined here ----
    {
      const f = new FileBuilder(`src/Api/Security/ComposeDependencies${t}.cs`);
      f.push('namespace Bridge.Api.Security');
      f.push('{');
      const classLine = f.push(`    public class ComposeDependencies${t}`);
      f.push('    {');
      f.push('        public void Register(object services)');
      f.push('        {');
      const callLine = f.push(`            services.AddAuthentication().AddJwtBearer${t}(o => o.ToString());`);
      f.push('        }');
      f.push('    }');
      f.push('}');
      f.write(root, filler);
      catalog.composes.push({
        file: f.rel,
        cls: { name: `ComposeDependencies${t}`, line: classLine },
        call: { text: `AddJwtBearer${t}(`, name: `AddJwtBearer${t}`, line: callLine },
      });
    }

    // ---- C# duplicated enum (the Privilege two-copies shape) ----
    {
      const files = [`src/Api/Enums/Privilege${t}.cs`, `src/Legacy/Model/Privilege${t}.cs`];
      const lines = [];
      for (const rel of files) {
        const f = new FileBuilder(rel);
        f.push(rel.startsWith('src/Api') ? 'namespace Bridge.Api.Enums' : 'namespace Vms.Model');
        f.push('{');
        lines.push(f.push(`    public enum Privilege${t}`));
        f.push('    {');
        f.push('        None = 0,');
        f.push('        Admin = 1');
        f.push('    }');
        f.push('}');
        f.write(root, filler);
      }
      catalog.enums.push({ name: `Privilege${t}`, files, lines });
    }

    // ---- C# interface ----
    {
      const f = new FileBuilder(`src/Api/Services/IUserService${t}.cs`);
      f.push('namespace Bridge.Api.Services');
      f.push('{');
      const ifaceLine = f.push(`    public interface IUserService${t}`);
      f.push('    {');
      f.push('        string Describe();');
      f.push('    }');
      f.push('}');
      f.write(root, filler);
      catalog.interfaces.push({ file: f.rel, iface: { name: `IUserService${t}`, line: ifaceLine } });
    }

    // ---- Python worker ----
    {
      const f = new FileBuilder(`src/py/queue_worker_${t}.py`);
      const constLine = f.push(`RETRY_LIMIT_${t} = ${i + 2}`);
      const classLine = f.push(`class QueueWorker${t}:`);
      const methodLine = f.push(`    def process_batch_${t}(self):`);
      f.push(`        return ${t}`);
      const fnLine = f.push(`def fetch_rows_${t}(limit):`);
      f.push('    return list(range(limit))');
      f.write(root, filler);
      catalog.python.push({
        file: f.rel,
        constant: { name: `RETRY_LIMIT_${t}`, line: constLine },
        cls: { name: `QueueWorker${t}`, line: classLine },
        method: { name: `process_batch_${t}`, line: methodLine },
        fn: { name: `fetch_rows_${t}`, line: fnLine },
      });
    }

    // ---- JSON config with a dotted key ----
    {
      const f = new FileBuilder(`config/app-${t}.json`);
      f.push('{');
      const keyLine = f.push(`  "app.retry.maxCount${t}": ${i + 1},`);
      const specialLine = f.push(`  "price": "${SHARED_LITERALS.special}"`);
      f.push('}');
      // JSON gets no filler comments (must stay valid JSON) — write raw.
      const abs = path.join(root, f.rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, f.lines.join('\n') + '\n');
      catalog.configs.push({ file: f.rel, key: { text: `app.retry.maxCount${t}`, line: keyLine }, specialLine });
    }

    // ---- Markdown doc ----
    {
      const f = new FileBuilder(`docs/guide-${t}.md`);
      f.push(`# Guide ${t}`);
      const uniLine = f.push(`> ${SHARED_LITERALS.unicode}`);
      const phraseText = `rotate the signing key for window ${t}`;
      const phraseLine = f.push(`Operational note: ${phraseText}.`);
      f.write(root, filler);
      catalog.docs.push({ file: f.rel, uniLine, phrase: { text: phraseText, line: phraseLine } });
    }
  }

  // ---- Cross-language duplicate hub: BaseModel in TS and C# ----
  {
    const ts = new FileBuilder('src/models/BaseModel.ts');
    const tsLine = ts.push('export class BaseModel {');
    ts.push('  id = "";');
    ts.push('}');
    ts.write(root, filler);
    const cs = new FileBuilder('src/Legacy/Model/BaseModel.cs');
    cs.push('namespace Vms.Model');
    cs.push('{');
    const csLine = cs.push('    public class BaseModel');
    cs.push('    {');
    cs.push('    }');
    cs.push('}');
    cs.write(root, filler);
    catalog.hub = { name: 'BaseModel', files: [ts.rel, cs.rel], lines: [tsLine, csLine] };
  }

  return { root, scale, catalog };
}
