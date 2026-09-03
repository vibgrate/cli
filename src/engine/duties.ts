/**
 * Duty IR — what a callable's body would do, statement by statement,
 * reconstructed from its syntax tree. Nothing is compiled or run.
 *
 * Where `effects.ts` counts API tokens in the flattened text, this walks the
 * tree-sitter call sites the extractor already captured and emits an ordered
 * list of duties:
 *
 *   validate  SKU
 *   persist   Product        via SaveChangesAsync   [live]
 *   publish   ProductCreated via publishEvent       [live]
 *   respond   201                                    [live]
 *
 * Three things the text scan could not know:
 *
 *   1. **What the receiver is.** `_products.Create(dto)` is a store write
 *      because the file declares `IProductRepository _products`, not because
 *      the identifier is spelled like a store. Bindings come from field,
 *      property and constructor-parameter declarations in the same file (and
 *      the graph's DI type refs); spelling is only the fallback.
 *   2. **Whether the statement can run.** A call after `return` / `throw` in
 *      the same block is dead; a call inside `catch` / `except` / `rescue` is
 *      the failure path; a call under `if (dryRun) …` carries that guard;
 *      `if (false)` / `if (0)` is dead. This is one-function control flow
 *      only — no abstract interpretation, no cross-function facts.
 *   3. **What the object is.** `_context.Products.Add(product)` persists a
 *      `Product` because of the `Products` set and the `product` argument's
 *      declared type; `publishEvent(new ProductCreated(id))` publishes a
 *      `ProductCreated`; `return Ok(dto)` responds `200`.
 *
 * Output is bounded (24 duties, short strings) and carries identifiers only —
 * never a slice of source text longer than an identifier or a short guard.
 */
import type { Node } from 'web-tree-sitter';

export type DutyKind =
  | 'validate'
  | 'query'
  | 'persist'
  | 'http'
  | 'respond'
  | 'fs'
  | 'auth'
  | 'crypto'
  | 'publish'
  | 'consume'
  | 'cache'
  | 'log'
  | 'render'
  | 'delegate';

export interface Duty {
  /** Closed duty kind. */
  k: DutyKind;
  /** Domain object, when known (`Product`, `ProductCreated`, `201`). */
  o?: string;
  /** API / collaborator the duty goes through (`SaveChangesAsync`, `ProductService.Create`). */
  via?: string;
  /** Declared type of the receiver, when the file declares it (`IProductRepository`, `AsyncSession`). */
  t?: string;
  /** Condition the duty sits under (`dryRun`, `unless !user`), or `catch`. */
  g?: string;
  /** False when the site cannot run on the happy path (after return/throw, in catch, `if (false)`). */
  live: boolean;
  /** 0 for the body's own sites; 1–2 for duties inherited from callees. */
  hop?: number;
  /** 1-based line of the call site. */
  line: number;
}

/** Declared types of identifiers in a file (fields, properties, ctor params). */
export type Bindings = Map<string, string>;

const MAX_DUTIES = 24;
const MAX_GUARD = 40;

// ---------------------------------------------------------------------------
// Receiver typing.
// ---------------------------------------------------------------------------

type ReceiverClass = 'store' | 'http' | 'queue' | 'cache' | 'log' | 'auth' | 'crypto' | 'fs' | 'mediator' | 'response' | 'validator' | 'service' | 'unknown';

/** Known framework / library types by (suffix or exact) name, lowercase. */
const TYPE_CLASS: Array<[RegExp, ReceiverClass]> = [
  [/(?:^|\.)(?:i?)(?:[a-z]*repositor(?:y|ies)|[a-z]*repo|[a-z]*dao|dbcontext|[a-z]*context$|dbset|[a-z]*session|asyncsession|prismaclient|prisma|knex|entitymanager|[a-z]*unitofwork|iqueryable|[a-z]*collection|mongo[a-z]*|[a-z]*datasource|jdbctemplate|sqlx[a-z]*|[a-z]*store|querybuilder|model|[a-z]*table|connection|pool)$/, 'store'],
  [/(?:^|\.)(?:i?)(?:httpclient|[a-z]*httpclient|resttemplate|webclient|[a-z]*client|[a-z]*gateway|[a-z]*adapter|okhttpclient|axiosinstance|axios|fetch|[a-z]*apiclient|[a-z]*sdk|grpc[a-z]*|[a-z]*stub)$/, 'http'],
  [/(?:^|\.)(?:i?)(?:[a-z]*publisher|[a-z]*producer|[a-z]*bus|[a-z]*queue|[a-z]*topic|[a-z]*channel|[a-z]*emitter|applicationeventpublisher|ipublishendpoint|[a-z]*mailer|[a-z]*sender|[a-z]*notifier|kafka[a-z]*|rabbit[a-z]*|sqs[a-z]*|sns[a-z]*|celery|[a-z]*dispatcher)$/, 'queue'],
  [/(?:^|\.)(?:i?)(?:[a-z]*cache|imemorycache|idistributedcache|redis[a-z]*|memcached?)$/, 'cache'],
  [/(?:^|\.)(?:i?)(?:[a-z]*logger|log|logging|[a-z]*tracer|[a-z]*metrics|telemetry[a-z]*)$/, 'log'],
  [/(?:^|\.)(?:i?)(?:[a-z]*usermanager|signinmanager|[a-z]*passwordhasher|[a-z]*tokenservice|[a-z]*authservice|[a-z]*authenticator|[a-z]*jwt[a-z]*|passport|oauth[a-z]*|[a-z]*identityservice|[a-z]*credential[a-z]*)$/, 'auth'],
  [/(?:^|\.)(?:i?)(?:[a-z]*cipher|[a-z]*hasher|[a-z]*crypto[a-z]*|[a-z]*encryptor|[a-z]*signer|messagedigest|randomnumbergenerator)$/, 'crypto'],
  [/(?:^|\.)(?:i?)(?:[a-z]*filesystem|[a-z]*storage|[a-z]*blob[a-z]*|[a-z]*bucket|s3[a-z]*|filestream|streamreader|streamwriter|fs)$/, 'fs'],
  [/(?:^|\.)(?:i?)(?:mediator|isender|[a-z]*commandbus|[a-z]*querybus)$/, 'mediator'],
  [/(?:^|\.)(?:i?)(?:[a-z]*validator|validationcontext)$/, 'validator'],
  [/(?:^|\.)(?:i?)(?:[a-z]*service|[a-z]*usecase|[a-z]*interactor|[a-z]*handler|[a-z]*manager|[a-z]*facade)$/, 'service'],
];

/** Same classes by the *spelling* of an untyped receiver (last resort). */
const NAME_CLASS: Array<[RegExp, ReceiverClass]> = [
  [/^(?:_?(?:db|database|conn|connection|cur|cursor|session|tx|transaction|em|prisma|knex|orm|qs|queryset|objects|context|_context|dbcontext|ctx\.db|supabase|firestore|mongo|collection|table|store))$|(?:repositor(?:y|ies)|repo|dao|context|session|store|collection|model|entities|\.objects)$/i, 'store'],
  // Django: anything reached through `Model.objects` is the ORM.
  [/\.objects\b/, 'store'],
  [/^(?:_?(?:http|httpclient|client|axios|api|apiclient|gateway|adapter|sdk|fetcher|requests|httpx|aiohttp))$|(?:client|gateway|adapter|api)$/i, 'http'],
  [/^(?:_?(?:bus|queue|publisher|producer|emitter|events|eventbus|channel|topic|mailer|notifier|kafka|rabbit|sqs|sns|celery|sender|dispatcher))$|(?:bus|queue|publisher|producer|emitter|mailer|sender|dispatcher)$/i, 'queue'],
  [/^(?:_?(?:cache|redis|memcache|memcached))$|cache$/i, 'cache'],
  [/^(?:_?(?:log|logger|logging|console|tracer|metrics|telemetry|sentry))$|logger$/i, 'log'],
  [/^(?:_?(?:mediator|sender|commandbus|querybus))$/i, 'mediator'],
  [/^(?:res|response|reply|ctx\.res|w)$|(?:\.response|\.res)$/i, 'response'],
  [/^(?:_?(?:validator|validation|schema|rules))$|validator$/i, 'validator'],
  [/(?:service|usecase|interactor|handler|manager|facade)$/i, 'service'],
];

/** Types that spell `Http` but are request plumbing or a security builder, never an outbound client. */
const NOT_CLIENT = /(?:httpsecurity|httpcontext|httprequest|httpresponse|httpservletrequest|httpservletresponse|httpmessage|httpheaders|httpstatus|httpmethod|httpentity|httpsession|httpcontextaccessor|httprequestmessage|httpresponsemessage|clientsession)$/;
/** Schema DDL verbs (ActiveRecord / Alembic / Knex / TypeORM migrations, SQLAlchemy metadata). */
const DDL_VERB = /^(?:create_table|drop_table|add_column|remove_column|add_index|remove_index|change_column|rename_column|rename_table|add_reference|add_foreign_key|remove_foreign_key|create_join_table|change_table|alter_column|drop_index|create_index|bulk_insert|create_all|drop_all|run_migrations|createtable|droptable|addcolumn|dropcolumn|renamecolumn|createindex|dropindex|altertable|renametable)$/i;
const DDL_ARGS = /(?:create_all|drop_all|run_migrations|create_table|drop_table|createTable|dropTable)\b/;
/** Contexts and sessions that are request plumbing, never a store. */
const NOT_STORE = /(?:httpcontext|servletcontext|requestcontext|securitycontext|executioncontext|bindingcontext|validationcontext|actioncontext|filtercontext|hubcallercontext|synchronizationcontext|cancellationtoken|httpsession|websocketsession|clientsession|usersession|appcontext|applicationcontext|beancontext|springcontext|reactcontext|canvasrenderingcontext)$/;

function classifyType(typeName: string): ReceiverClass {
  const t = typeName.replace(/<.*$/, '').replace(/[?[\]*&]/g, '').toLowerCase();
  if (NOT_STORE.test(t)) return t.endsWith('httpcontext') ? 'response' : 'unknown';
  for (const [re, cls] of TYPE_CLASS) if (re.test(t)) return cls;
  return 'unknown';
}

function classifyName(receiver: string): ReceiverClass {
  const r = receiver.replace(/^(?:this|self|@|super)[.:>-]*/, '');
  for (const [re, cls] of NAME_CLASS) if (re.test(r)) return cls;
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Verb sets (reads / writes / responses …).
// ---------------------------------------------------------------------------

const READ = /^(?:find\w*|get\w*|load\w*|read\w*|fetch\w*|query\w*|select\w*|where|filter|first\w*|single\w*|last\w*|all|count\w*|exists\w*|any\w*|aggregate|search\w*|list\w*|lookup\w*|scan|one|many|paginate|include|asnotracking|tolist\w*|toarray\w*|execute(?:query|reader)\w*|raw|exec|values|pluck|only|defer|selectinload|joinedload|find_by|find_each|get_object_or_404|from|of|fetchone|fetchall|queryrow\w*|querycontext)$/i;
const WRITE = /^(?:save\w*|insert\w*|create\w*|update\w*|upsert\w*|delete\w*|remove\w*|destroy\w*|persist\w*|merge|flush|commit|add\w*|attach|detach|entry|bulk_\w+|get_or_create|update_or_create|executeupdate|executenonquery|namedexec|mustexec|increment|decrement|set|put|write\w*|store|truncate|drop|sync|push|touch|delete_all|update_all|insert_all|upsert_all|find_or_create_by|update_attributes?|savechanges\w*|addrange\w*|removerange|\$transaction|transaction)$/i;
/** ActiveRecord class-level finders and writers on a bare model constant. */
const RAILS_READ = /^(?:find|find_by|where|all|first|last|exists|count|pluck|order|includes|select|take|find_each|find_in_batches|joins|distinct|limit|sum|average|maximum|minimum|ids|find_or_initialize_by|find_sole_by|sole)$/;
const RAILS_WRITE = /^(?:create|update|destroy|destroy_all|delete|delete_all|update_all|insert|insert_all|upsert|upsert_all|find_or_create_by|create_or_find_by|touch_all|increment_counter|decrement_counter|update_counters)$/;
/** Unit-of-work verbs: a write with no object of its own. */
const UOW = /^(?:savechanges(?:async)?|commit|flush|\$transaction|transaction|begin_transaction|begintransaction|save_changes)$/i;
/** `execute` / `query` / `raw`: a read unless the statement text says otherwise. */
const AMBIGUOUS_EXEC = /^(?:execute|executeasync|exec|query|queryasync|raw|run|sql|statement|execute_query|executequery|executescalar|executeraw|queryraw|\$executeraw|\$queryraw|executesql|executesqlraw)$/i;
const SQL_WRITE_WORDS = /\b(?:insert|update|delete|merge|drop|alter|truncate|upsert|create\s+(?:table|index))\b/i;
const HTTP_VERB = /^(?:get|post|put|patch|delete|head|options|request|send|fetch|do|call|invoke|getasync|postasync|putasync|deleteasync|patchasync|postasjsonasync|putasjsonasync|getstringasync|getfromjsonasync|sendasync|getforobject|getforentity|postforobject|postforentity|exchange|execute|urlopen|newrequest|ajax)$/i;
const PUBLISH_VERB = /^(?:publish\w*|emit|enqueue|send\w*|dispatch|broadcast\w*|produce|push|add|notify\w*|raise\w*|fire\w*|trigger\w*|deliver\w*|perform_later|perform_async|delay|apply_async|sendmail|send_mail|deliver_now|deliver_later|publishevent)$/i;
const CACHE_VERB = /^(?:get\w*|set\w*|del|delete\w*|has|remember|fetch|wrap|clear|invalidate\w*|getorcreate\w*|getorset\w*|expire|ttl|incr|decr|write|read)$/i;
const LOG_VERB = /^(?:log\w*|info|warn\w*|error|debug|trace|fatal|critical|exception|record\w*|track\w*|capture\w*|increment|gauge|histogram|timing)$/i;
const AUTH_VERB = /^(?:authenticate\w*|login\w*|logout\w*|signin\w*|signout\w*|verify\w*|check\w*|validate\w*|hash\w*|compare\w*|issue\w*|create\w*token\w*|generate\w*token\w*|decode\w*|refresh\w*|authorize\w*|authorise\w*|getuser\w*|findbyname\w*|checkpassword\w*)$/i;
const CRYPTO_VERB = /^(?:encrypt\w*|decrypt\w*|hash\w*|sign\w*|verify\w*|digest\w*|random\w*|derive\w*|hmac\w*|createhash|createhmac|createcipher\w*|createdecipher\w*|sha\d*|md5)$/i;
const FS_VERB = /^(?:read\w*|write\w*|open\w*|exists\w*|delete\w*|copy\w*|move\w*|mkdir\w*|readdir\w*|unlink\w*|stat\w*|append\w*|createreadstream|createwritestream|upload\w*|download\w*|put\w*|get\w*|list\w*|walk|glob)$/i;
const VALIDATE_VERB = /^(?:validate\w*|parse\w*|safeparse|assert\w*|ensure\w*|check\w*|verify\w*|require\w*|guard\w*|rulefor|must\w*|is_valid|full_clean|invariant|precondition|validateandthrow\w*|validateasync)$/i;
const RESPOND_VERB = /^(?:ok|created|createdataction|createdatroute|nocontent|notfound|badrequest|unauthorized|forbid|accepted|conflict|problem|statuscode|json|view|partialview|redirect\w*|file|content|send\w*|status|end|write\w*|render|jsonify|jsonresponse|httpresponse\w*|writeheader|encode|string|html|text)$/i;
const RENDER_VERB = /^(?:render\w*|createelement|html|view|template|partial|component|mount|hydrate|build|setcontent)$/i;

/** HTTP status code implied by a response verb. */
const STATUS_OF: Record<string, string> = {
  ok: '200', json: '200', view: '200', content: '200', file: '200', send: '200', render: '200', jsonify: '200', text: '200', html: '200', string: '200', encode: '200',
  created: '201', createdataction: '201', createdatroute: '201',
  accepted: '202', nocontent: '204', redirect: '302', redirecttoaction: '302',
  badrequest: '400', unauthorized: '401', forbid: '403', notfound: '404', conflict: '409', unprocessableentity: '422', problem: '500',
};

// ---------------------------------------------------------------------------
// Bindings: declared types of fields / properties / constructor params.
// ---------------------------------------------------------------------------

const BINDING_PATTERNS: RegExp[] = [
  // C# / Java / Kotlin-ish fields and ctor params: `private readonly IFoo _foo;` `IFoo foo,` `IFoo foo)`
  /\b(?:private|protected|public|internal|readonly|final|static|val|var|lateinit|@\w+)?\s*(?:readonly\s+)?([A-Z][\w.]*(?:<[^<>]*(?:<[^<>]*>[^<>]*)*>)?\??)\s+(_?[a-z]\w*)\s*(?:[;=,)]|\{\s*get)/g,
  // TS / Kotlin / Swift / Dart / Scala: `private readonly foo: Foo` / `val foo: Foo` / `foo: Foo,`
  /\b(?:private|protected|public|readonly|val|var|let|const|override)?\s*(?:readonly\s+)?(_?[a-z]\w*)\s*:\s*([A-Z][\w.]*(?:<[^<>]*(?:<[^<>]*>[^<>]*)*>)?\??)\s*(?:[;=,)]|$)/gm,
  // Python: `self.foo = Foo(` / `self.foo: Foo` / `foo: Foo,` in __init__
  /\bself\.(\w+)\s*(?::\s*([A-Z]\w*)|=\s*([A-Z]\w*)\s*\()/g,
  /\bdef\s+__init__\s*\(([^)]*)\)/g,
  // PHP / Ruby: `private Foo $foo` / `@foo = Foo.new`
  /\b(?:private|protected|public)\s+(?:readonly\s+)?\??([A-Z]\w*)\s+\$(\w+)/g,
  /@(\w+)\s*=\s*([A-Z]\w*)\.new\b/g,
];

/** Declared types of identifiers in a file. First declaration wins. */
export function fileBindings(text: string, langId: string): Bindings {
  const out: Bindings = new Map();
  const put = (name: string, type: string): void => {
    if (!name || !type || out.has(name)) return;
    const t = type.replace(/\?$/, '');
    if (/^(?:string|int|long|bool|boolean|double|float|decimal|object|void|var|let|const|new|return|await|async|readonly|static|public|private|protected|internal|override|virtual|abstract|final|def|fn|function|class|interface|enum|struct|record|this|self|null|true|false|List|Dictionary|Map|Set|Array|Task|Promise|Optional|Result|Guid|DateTime|CancellationToken|Exception)$/.test(t)) return;
    out.set(name, t);
    // `this.foo` / `self.foo` / `_foo` / `foo` all name the same member.
    out.set(name.replace(/^_/, ''), t);
  };
  const clipped = text.length > 200_000 ? text.slice(0, 200_000) : text;
  // Pattern 0: C#/Java style `Type name`.
  for (const m of clipped.matchAll(BINDING_PATTERNS[0]!)) put(m[2]!, m[1]!);
  // Pattern 1: `name: Type`.
  for (const m of clipped.matchAll(BINDING_PATTERNS[1]!)) put(m[1]!, m[2]!);
  if (langId === 'py') {
    for (const m of clipped.matchAll(BINDING_PATTERNS[2]!)) put(m[1]!, m[2] ?? m[3] ?? '');
    for (const m of clipped.matchAll(BINDING_PATTERNS[3]!)) {
      for (const part of m[1]!.split(',')) {
        const mm = /^\s*(\w+)\s*:\s*([A-Z]\w*)/.exec(part);
        if (mm) put(mm[1]!, mm[2]!);
      }
    }
  }
  if (langId === 'php') for (const m of clipped.matchAll(BINDING_PATTERNS[4]!)) put(m[2]!, m[1]!);
  if (langId === 'rb') for (const m of clipped.matchAll(BINDING_PATTERNS[5]!)) put(m[1]!, m[2]!);
  return out;
}

/** Local `var x = new Foo()` / `Foo x = …` / `x: Foo = …` / `x = Foo(` inside a body. */
function localTypes(bodyText: string): Bindings {
  const out: Bindings = new Map();
  const put = (n: string, t: string): void => {
    if (n && t && /^[A-Z]/.test(t) && !out.has(n)) out.set(n, t);
  };
  for (const m of bodyText.matchAll(/\b(?:var|let|const|final|val)\s+(\w+)\s*(?::\s*([A-Z]\w*))?\s*=\s*(?:new\s+|await\s+)?([A-Z]\w*)?/g)) put(m[1]!, m[2] ?? m[3] ?? '');
  for (const m of bodyText.matchAll(/\b([A-Z]\w*(?:<[^>]*>)?)\s+(\w+)\s*=\s*(?:new\s+)?/g)) put(m[2]!, m[1]!.replace(/<.*$/, ''));
  for (const m of bodyText.matchAll(/\b(\w+)\s*=\s*([A-Z]\w*)\s*\(/g)) put(m[1]!, m[2]!);
  // `query = select(Product).where(…)`: the local carries the table it reads.
  for (const m of bodyText.matchAll(/\b(\w+)\s*=\s*(?:select|query|from|Query)\s*[(<]\s*([A-Z]\w*)/g)) put(m[1]!, m[2]!);
  return out;
}

// ---------------------------------------------------------------------------
// Tree helpers.
// ---------------------------------------------------------------------------

const CALL_TYPE = /call|invocation|message_expression|object_creation|new_expression|command|macro_invocation/;
const BLOCK_TYPE = /^(?:block|statement_block|body|statement_list|program|module|suite|compound_statement|do_block|then|else|else_clause|function_body|method_body|class_body|source_file|declaration_list|expression_statement_list|begin_block|block_body|control_structure_body|switch_section|case_clause|when_entry)$/;
const TERMINAL_TYPE = /^(?:return|throw|raise|panic|break|continue|exit|yield_break|goto|unreachable)(?:_statement|_expression)?$/;
const COND_TYPE = /^(?:if|if_statement|if_expression|conditional_expression|ternary_expression|unless|unless_statement|switch_statement|switch_expression|match_expression|match_statement|when_expression|when|case_statement|guard_statement|elif_clause|else_if_clause|conditional|if_modifier|unless_modifier)$/;
const CATCH_TYPE = /^(?:catch_clause|except_clause|rescue|rescue_clause|rescue_modifier|catch|finally_clause|finally|except_group_clause|on_part|catch_block)$/;
const LOOP_TYPE = /^(?:for|while|foreach|loop|do)_?(?:statement|expression|in_statement|each)?$/;

function callNodeOf(callee: Node): Node | null {
  let n: Node | null = callee;
  for (let i = 0; i < 5 && n; i++) {
    if (CALL_TYPE.test(n.type) && !/identifier|name$/.test(n.type)) return n;
    n = n.parent;
  }
  return null;
}

function argumentsText(call: Node): string {
  const args =
    call.childForFieldName('arguments') ??
    call.childForFieldName('argument_list') ??
    call.namedChildren.find((c) => c && /argument|arguments|args/.test(c.type)) ??
    null;
  if (args) return args.text;
  const open = call.text.indexOf('(');
  return open >= 0 ? call.text.slice(open) : '';
}

/** Receiver expression text (`_context.Products`, `this.products`), or ''. */
function receiverOf(call: Node, callee: Node): string {
  const fn = call.childForFieldName('function') ?? call.childForFieldName('receiver') ?? call.childForFieldName('object') ?? null;
  let head = '';
  if (fn && fn.type !== callee.type) head = fn.text;
  else head = call.text.slice(0, Math.max(0, callee.startIndex - call.startIndex + callee.text.length));
  // Drop the trailing callee segment and any separator.
  const idx = head.lastIndexOf(callee.text);
  if (idx > 0) head = head.slice(0, idx).replace(/[.:>\-?!\s]+$/, '');
  else if (idx === 0) head = '';
  return head.replace(/\s+/g, '').slice(0, 80);
}

function statementOf(call: Node, def: Node): Node {
  let n: Node = call;
  while (n.parent && n.parent.id !== def.id && !BLOCK_TYPE.test(n.parent.type)) n = n.parent;
  return n;
}

function shortCondition(node: Node): string {
  const cond = node.childForFieldName('condition') ?? node.childForFieldName('value') ?? node.namedChildren[0] ?? null;
  let raw = (cond?.text ?? node.text.split('\n')[0] ?? '').replace(/^\((.*)\)$/s, '$1').replace(/\s+/g, ' ').trim();
  // `productRepository.existsBySku(request.getSku())` → `existsBySku(…)`:
  // a guard names the check, not the receiver chain or the arguments.
  raw = raw.replace(/\(([^()]|\([^()]*\))*\)/g, '(…)').replace(/\b(?:this|self|@)[.:>-]*/g, '').replace(/\b[\w$]+(?:\.|->|::)(?=[\w$]+)/g, '');
  return raw.length > MAX_GUARD ? `${raw.slice(0, MAX_GUARD - 1)}…` : raw;
}

function isConstantFalse(cond: string): boolean {
  return /^(?:false|0|null|nil|None|False|!true|!1)$/.test(cond.trim());
}

/** Liveness and guard of a call site within its definition. */
function controlFlow(call: Node, def: Node): { live: boolean; guard?: string } {
  let live = true;
  let guard: string | undefined;
  // Ancestors: conditionals, catch clauses, `if (false)`.
  let n: Node | null = call.parent;
  let inCatch = false;
  while (n && n.id !== def.id) {
    if (CATCH_TYPE.test(n.type)) inCatch = true;
    else if (COND_TYPE.test(n.type)) {
      // The call may be the condition itself (`if (repo.exists(x))`): then it
      // always runs, and this conditional guards nothing about it.
      const condNode = n.childForFieldName('condition');
      if (condNode && condNode.startIndex <= call.startIndex && call.endIndex <= condNode.endIndex) {
        n = n.parent;
        continue;
      }
      const cond = shortCondition(n);
      if (isConstantFalse(cond)) live = false;
      // Is the call in the alternative branch of this conditional?
      const alt = n.childForFieldName('alternative');
      const inAlt = alt != null && alt.startIndex <= call.startIndex && call.endIndex <= alt.endIndex;
      if (!guard && cond) guard = inAlt ? `not ${cond}` : cond;
    }
    n = n.parent;
  }
  if (inCatch) return { live: false, guard: 'catch' };
  // Dead code: a terminal statement earlier in the same block.
  const stmt = statementOf(call, def);
  let prev = stmt.previousNamedSibling;
  const earlyReturns: string[] = [];
  while (prev) {
    if (TERMINAL_TYPE.test(prev.type) || (prev.type === 'expression_statement' && prev.namedChildren[0] && TERMINAL_TYPE.test(prev.namedChildren[0].type))) {
      live = false;
      break;
    }
    // `if (x) return;` before the site: the site runs only when !x.
    if (COND_TYPE.test(prev.type) && /\b(?:return|throw|raise|panic|exit)\b/.test(prev.text) && prev.text.length <= 160 && !prev.childForFieldName('alternative')) {
      const cond = shortCondition(prev);
      if (cond) earlyReturns.push(cond);
    }
    prev = prev.previousNamedSibling;
  }
  if (!guard && earlyReturns.length) guard = `unless ${earlyReturns[earlyReturns.length - 1]}`;
  return { live, guard };
}

// ---------------------------------------------------------------------------
// Object (noun) extraction.
// ---------------------------------------------------------------------------

function singular(word: string): string {
  if (/ies$/.test(word)) return word.replace(/ies$/, 'y');
  if (/(?:ses|xes|ches|shes)$/.test(word)) return word.replace(/es$/, '');
  if (/s$/.test(word) && !/ss$/.test(word)) return word.replace(/s$/, '');
  return word;
}

const PLUMBING = /^(?:CancellationToken|Request|Response|HttpContext|Context|Logger|ILogger|Session|Task|Promise|String|Int32|Int64|Long|Integer|Boolean|Guid|DateTime|Object|Any|Dict|List|Map|Set|Array|Exception|Error|Unit|Void|None|Type|Self|Cls|Args|Kwargs|Value|Data|Result|Ok|Err|Some|Query|Stmt|Statement|Sql|Cursor|Conn|Connection|Tx|Transaction|Db|Database)$/;

/** `select(Product)` / `FROM products` / `Set<Product>`: the table a query reads. */
function nounFromQuery(args: string): string | undefined {
  const m = /\b(?:select|from|query|SelectMany|Set|Table|Query)\s*[(<]\s*([A-Z]\w*)/.exec(args) ?? /\bfrom\s+["'`]?([A-Za-z_]\w*)/i.exec(args);
  if (!m) return undefined;
  const raw = m[1]!;
  const cap = raw[0]!.toUpperCase() + raw.slice(1);
  return PLUMBING.test(cap) ? undefined : domainNoun(singular(cap));
}

/** Raw declared type of the first typed argument (`CreateProductCommand`), for handler lookup. */
function rawTypeFromArgs(args: string, bindings: Bindings, locals: Bindings): string | undefined {
  const inner = args.replace(/^\(|\)$/g, '');
  const ctor = /\bnew\s+([A-Z]\w*)|(?:^|[\s,(])([A-Z]\w*)\s*[({]/.exec(inner);
  const ctorName = ctor?.[1] ?? ctor?.[2];
  if (ctorName && !PLUMBING.test(ctorName)) return ctorName;
  for (const m of inner.matchAll(/(?:^|[\s,(])(?:this\.|self\.|@)?([a-z_]\w*)\b/g)) {
    const t = (locals.get(m[1]!) ?? bindings.get(m[1]!))?.replace(/<.*$/, '');
    if (t && !PLUMBING.test(t)) return t;
  }
  return undefined;
}

function nounFromArgs(args: string, bindings: Bindings, locals: Bindings): string | undefined {
  const inner = args.replace(/^\(|\)$/g, '');
  // `new ProductCreated(…)` / `ProductCreated(…)` / `ProductCreated { … }`
  const ctor = /\bnew\s+([A-Z]\w*)|(?:^|[\s,(])([A-Z]\w*)\s*[({]/.exec(inner);
  const ctorName = ctor?.[1] ?? ctor?.[2];
  if (ctorName && !PLUMBING.test(ctorName)) return ctorName;
  // First identifier argument with a known declared type.
  for (const m of inner.matchAll(/(?:^|[\s,(])(?:this\.|self\.|@)?([a-z_]\w*)\b/g)) {
    const t = locals.get(m[1]!) ?? bindings.get(m[1]!);
    const noun = domainNoun(t);
    if (noun) return noun;
  }
  // A bare identifier argument: capitalise it (`product` → `Product`).
  const first = /^\s*(?:this\.|self\.|@)?([a-z][a-zA-Z0-9]*)\s*(?:,|$)/.exec(inner);
  if (first && first[1]!.length > 2 && !/^(?:id|ids|dto|req|res|ctx|cb|err|error|args|opts|options|params|data|value|key|name|input|output|request|response|token|cancellationtoken|ct)$/i.test(first[1]!)) {
    return first[1]![0]!.toUpperCase() + first[1]!.slice(1).replace(/(?:Dto|Request|Command|Query|Input|Model)$/, '');
  }
  return undefined;
}

/** `_context.Products` → `Product`; `this.orders` → `Order`; `prisma.user` → `User`. */
function nounFromReceiver(receiver: string): string | undefined {
  const segs = receiver.split(/[.:>\-?!]+/).filter(Boolean);
  // Django's `User.objects.filter(...)` names the model before `objects`.
  const objects = segs.indexOf('objects');
  if (objects >= 1) segs.length = objects;
  const last = segs[segs.length - 1];
  if (!last) return undefined;
  const clean = last.replace(/^[_@$]+/, '');
  if (/^(?:db|context|_context|dbContext|session|prisma|repo|repository|em|manager|orm|conn|tx|store|client|http|cache|logger|log|bus|queue|mediator|this|self|base|super|ctx|entities)$/i.test(clean)) return undefined;
  if (/^[A-Z]/.test(clean)) return domainNoun(singular(clean));
  if (clean.length > 3) return domainNoun(singular(clean[0]!.toUpperCase() + clean.slice(1)));
  return undefined;
}

/** `CreateProductDto` → `Product`; `IProductRepository` → `Product`; `IEnumerable<Order>` → `Order`. */
export function domainNoun(typeName: string | undefined): string | undefined {
  if (!typeName) return undefined;
  const generic = /<\s*([A-Z]\w*)/.exec(typeName);
  if (generic) return domainNoun(generic[1]);
  let bare = typeName.replace(/[?[\]*&]/g, '').replace(/^I(?=[A-Z])/, '');
  bare = bare.replace(/(?:Dto|DTO|Request|Command|Query|Input|Output|Model|Entity|Response|Repository|Repo|Dao|Service|Client|Store|Set|Collection|Context|Event|Message|Params|Args|Options)$/, '') || bare;
  const stripped = bare.replace(/^(?:Create|Update|Delete|Remove|Get|Find|List|Add|Register|Save|Fetch|Load|Search|Cancel|Approve|Reject|Sync|Send|Publish)(?=[A-Z])/, '');
  if (stripped) bare = stripped;
  return bare && /^[A-Z]/.test(bare) && !PLUMBING.test(bare) ? bare : undefined;
}

function nounFromType(typeName: string | undefined): string | undefined {
  return domainNoun(typeName);
}

// ---------------------------------------------------------------------------
// Classification of one call site.
// ---------------------------------------------------------------------------

interface Site {
  call: Node;
  callee: Node;
}

function classifySite(site: Site, def: Node, langId: string, bindings: Bindings, locals: Bindings, calleeOf: (n: Node) => string | undefined): Duty | undefined {
  const callee = site.callee.text;
  const verb = callee.replace(/[!?]$/, '');
  const receiver = receiverOf(site.call, site.callee);
  const base = receiver.replace(/^(?:this|self|@|super)[.:>-]*/, '').split(/[.:>\-?!]+/)[0] ?? '';
  const declared = base ? (bindings.get(base) ?? locals.get(base)) : undefined;
  let cls: ReceiverClass = declared ? classifyType(declared) : 'unknown';
  // A receiver *declared* as request plumbing (`HttpSecurity http`) keeps
  // that answer; only an untyped receiver falls back to its spelling.
  const typedPlumbing = !!declared && NOT_CLIENT.test(declared.replace(/<.*$/, '').toLowerCase());
  if (cls === 'unknown' && receiver && !typedPlumbing) cls = classifyName(receiver);
  const args = argumentsText(site.call);
  const flow = controlFlow(site.call, def);
  const line = site.call.startPosition.row + 1;
  const declaredShort = declared?.replace(/<.*$/, '').replace(/[?[\]*&]/g, '');
  const mk = (k: DutyKind, o?: string, via?: string): Duty => {
    const d: Duty = { k, live: flow.live, line };
    if (o) d.o = o;
    if (via) d.via = via;
    if (declaredShort) d.t = declaredShort.slice(0, 40);
    if (flow.guard) d.g = flow.guard;
    return d;
  };
  const viaOf = (): string => (receiver ? `${receiver.split(/[.:>\-?!]+/).filter(Boolean).slice(-1)[0]}.${callee}` : callee).slice(0, 60);
  // A typed collaborator is cited by its type (`ProductService.Create`), which
  // the inherit pass can resolve to the callee even when the edge resolver
  // could not follow the receiver.
  const typedVia = (): string => (declaredShort ? `${declaredShort}.${callee}` : viaOf()).slice(0, 60);
  const lower = verb.toLowerCase();

  // Unit-of-work verbs: a write, no object of its own.
  if (UOW.test(lower) && (cls === 'store' || cls === 'unknown')) {
    return mk('persist', undefined, viaOf());
  }
  // Strong, receiver-independent verbs.
  if (/^(?:saveandflush|saveall|insertmany|insertone|createmany|updatemany|deletemany|bulk_create|bulk_update|get_or_create|update_or_create|executeupdate|find_or_create_by)$/i.test(lower) || /^(?:save|update|create|destroy)!$/.test(callee)) {
    // `@post.update!(published_at: Time.current)`: the instance is the object,
    // not the value it is being given.
    const instanceFirst = /!$/.test(callee) || /^[@$]/.test(receiver);
    const obj = instanceFirst
      ? (nounFromReceiver(receiver) ?? nounFromArgs(args, bindings, locals) ?? nounFromType(declared))
      : (nounFromArgs(args, bindings, locals) ?? nounFromReceiver(receiver) ?? nounFromType(declared));
    return mk('persist', obj, callee);
  }
  // Rails: an instance variable holding a record writes itself (`@post.save`, `@post.update(attrs)`).
  if (langId === 'rb' && /^@\w+$/.test(receiver) && /^(?:save|destroy|update|update_attributes?|update_columns?|touch|delete|increment|decrement|toggle)$/.test(verb)) {
    return mk('persist', nounFromReceiver(receiver), viaOf());
  }
  // Schema DDL: a migration's `create_table :posts`, Alembic's `op.drop_table`,
  // SQLAlchemy's `Base.metadata.create_all` (also through `conn.run_sync`).
  if (
    (DDL_VERB.test(verb) && (!receiver || cls === 'store' || /(?:^|\.)(?:op|migration|schema|metadata|queryinterface|queryrunner|knex)$/i.test(receiver))) ||
    (cls === 'store' && /^(?:run_sync|run)$/.test(verb) && DDL_ARGS.test(args))
  ) {
    const table = /[:'"`](\w+)/.exec(args)?.[1];
    return mk('persist', table ? domainNoun(singular(table[0]!.toUpperCase() + table.slice(1))) : undefined, viaOf());
  }
  // Rails: a bare model constant is the store (`Post.find(id)`, `Post.create!(attrs)`).
  if (langId === 'rb' && /^[A-Z]\w*$/.test(receiver)) {
    if (RAILS_WRITE.test(verb)) return mk('persist', nounFromReceiver(receiver), viaOf());
    if (RAILS_READ.test(verb)) return mk('query', nounFromReceiver(receiver), viaOf());
  }
  // Rails / Sidekiq: `PostMailer.published(post).deliver_later`, `Job.perform_later(id)`.
  if (langId === 'rb' && /^(?:deliver_later|deliver_now|perform_later|perform_async|perform_in|perform_at)$/.test(verb)) {
    return mk('publish', nounFromReceiver(base) ?? rawTypeFromArgs(args, bindings, locals), viaOf());
  }
  if (/^(?:findunique|findmany|findfirst|findone|findall|findbyid|findbypk|tolistasync|toarrayasync|firstordefaultasync|singleordefaultasync|anyasync|countasync|findasync|asnotracking|fetchone|fetchall|find_by|find_each|selectinload|joinedload|get_object_or_404)$/i.test(lower)) {
    return mk('query', nounFromReceiver(receiver) ?? nounFromType(declared) ?? nounFromArgs(args, bindings, locals), callee);
  }
  if (/^(?:fetch|urlopen)$/i.test(lower) && !receiver) return mk('http', undefined, callee);

  switch (cls) {
    case 'store': {
      if (AMBIGUOUS_EXEC.test(verb)) {
        const write = SQL_WRITE_WORDS.test(args);
        return mk(write ? 'persist' : 'query', nounFromQuery(args) ?? nounFromArgs(args, bindings, locals) ?? nounFromReceiver(receiver) ?? nounFromType(declared), viaOf());
      }
      if (WRITE.test(verb)) return mk('persist', nounFromArgs(args, bindings, locals) ?? nounFromReceiver(receiver) ?? nounFromType(declared), viaOf());
      if (READ.test(verb)) return mk('query', nounFromQuery(args) ?? nounFromReceiver(receiver) ?? nounFromType(declared) ?? nounFromArgs(args, bindings, locals), viaOf());
      break;
    }
    case 'http': {
      // A receiver *declared* as an HTTP client calls out whatever the
      // method is named (`paymentClient.charge`); an untyped one needs a verb.
      if (declared || HTTP_VERB.test(verb) || /async$/i.test(verb)) {
        const path = /["'`]([^"'`\s]{1,60})["'`]/.exec(args)?.[1];
        return mk('http', nounFromArgs(args.replace(/["'`][^"'`]*["'`]/g, ''), bindings, locals) ?? (path ? path : undefined), viaOf());
      }
      break;
    }
    case 'queue': {
      if (PUBLISH_VERB.test(verb)) return mk('publish', nounFromArgs(args, bindings, locals), viaOf());
      break;
    }
    case 'mediator': {
      if (/^publish\w*$/i.test(verb)) return mk('publish', nounFromArgs(args, bindings, locals), viaOf());
      // The command type names the handler (`CreateProductCommand` → `CreateProductCommandHandler`).
      if (/^send\w*$/i.test(verb)) return mk('delegate', rawTypeFromArgs(args, bindings, locals), viaOf());
      break;
    }
    case 'cache': {
      if (CACHE_VERB.test(verb)) return mk('cache', nounFromArgs(args, bindings, locals), viaOf());
      break;
    }
    case 'log': {
      if (LOG_VERB.test(verb)) return mk('log', undefined, viaOf());
      break;
    }
    case 'auth': {
      if (AUTH_VERB.test(verb)) return mk('auth', nounFromArgs(args, bindings, locals), viaOf());
      break;
    }
    case 'crypto': {
      if (CRYPTO_VERB.test(verb)) return mk('crypto', undefined, viaOf());
      break;
    }
    case 'fs': {
      if (FS_VERB.test(verb)) return mk('fs', nounFromArgs(args, bindings, locals), viaOf());
      break;
    }
    case 'response': {
      const inner = args.replace(/^\(|\)$/g, '').trim();
      // `res.json()` / `res.text()` with no argument reads a fetch Response.
      if (/^(?:json|text|send|write|end|encode|html)$/i.test(lower) && !inner) break;
      if (RESPOND_VERB.test(verb)) {
        const code = /\b([1-5]\d\d)\b/.exec(args)?.[1] ?? STATUS_OF[lower];
        return mk('respond', code, viaOf());
      }
      break;
    }
    case 'validator': {
      if (VALIDATE_VERB.test(verb) || /^(?:for|rulefor|when|must)$/i.test(verb)) return mk('validate', nounFromArgs(args, bindings, locals), viaOf());
      break;
    }
    case 'service': {
      // A collaborator call: a delegate duty the inherit pass can expand.
      return mk('delegate', rawTypeFromArgs(args, bindings, locals), typedVia());
    }
    default:
      break;
  }

  // Receiver-free duties by verb alone.
  if (!receiver || /^(?:this|self|@)$/.test(receiver)) {
    if ((langId === 'rb' || langId === 'py') && /^(?:render|render_template|render_to_response|redirect_to|head|respond_with|respond_to)$/.test(verb)) {
      // `render :new` / `render_template('x.html')` draws a template: UI
      // rendering. `render json: @post` / `redirect_to` only answer.
      const template = /^render_t/.test(verb) || (verb === 'render' && (/^\s*(?::\w+|['"]|template:|partial:|action:|html:|layout:)/.test(args) || /['"][\w/.-]+\.html?['"]/.test(args)));
      if (template) {
        const name = /(?::(\w+)|['"]([\w/.-]+)['"])/.exec(args);
        return mk('render', name?.[1] ?? name?.[2], callee);
      }
      const named = /status:\s*:(\w+)/.exec(args)?.[1]?.replace(/_/g, '');
      const code = /\b([1-5]\d\d)\b/.exec(args)?.[1] ?? (named ? STATUS_OF[named] : undefined) ?? (verb === 'redirect_to' ? '302' : '200');
      return mk('respond', code, callee);
    }
    // A bare fetch helper (`fetchApi('/cart')`, `apiGet`, `httpPost`, `request(`) calls out.
    if (/^(?:fetch(?:api|json|with\w+)|\w*api(?:fetch|get|post|put|patch|delete|request|call)|http(?:get|post|put|patch|delete|request)|fetcher|request)$/i.test(verb)) {
      const path = /["'`]([^"'`\s]{1,60})["'`]/.exec(args)?.[1];
      return mk('http', path, callee);
    }
    if (/^(?:ok|created|createdataction|createdatroute|nocontent|notfound|badrequest|unauthorized|forbid|accepted|conflict|problem|statuscode|jsonify|jsonresponse|httpresponse\w*|redirect(?:toaction|toroute)?)$/i.test(lower)) {
      return mk('respond', /\b([1-5]\d\d)\b/.exec(args)?.[1] ?? STATUS_OF[lower], callee);
    }
    if (/^(?:render|render_template|renderToString|createElement|jsx|jsxs|h)$/i.test(verb)) return mk('render', nounFromArgs(args, bindings, locals), callee);
    if (/^(?:validate\w*|assert\w*|invariant|precondition|is_valid|full_clean|ensure\w*)$/i.test(verb)) return mk('validate', nounFromArgs(args, bindings, locals), callee);
    if (/^(?:bcrypt|checkpw|hashpw|verify_password|get_password_hash|check_password|create_access_token|create_refresh_token|decode_token|verify_token|authenticate|login_user|logout_user|comparePassword|verifyPassword)$/i.test(verb)) return mk('auth', nounFromArgs(args, bindings, locals), callee);
    if (/^(?:publishEvent|publish|emit|broadcast|dispatch|sendEmail|send_mail|deliver_now|deliver_later)$/i.test(verb)) return mk('publish', nounFromArgs(args, bindings, locals), callee);
  }
  // Store-shaped strong verbs on an untyped, unspelled receiver stay quiet:
  // `catalog.put(x)` without a declared type is not evidence.
  // A resolved same-file / cross-file callee that is itself a callable is a
  // delegation the inherit pass can follow.
  const resolved = calleeOf(site.callee);
  if (resolved) return mk('delegate', rawTypeFromArgs(args, bindings, locals), resolved.slice(0, 60));
  // Ruby service objects: `PostPublisher.new(post).call` is `PostPublisher.call`,
  // which the inherit pass resolves by qualified name.
  if (langId === 'rb') {
    const ctor = /^([A-Z]\w*(?:::[A-Z]\w*)*)\.new\b/.exec(receiver)?.[1];
    if (ctor && /^(?:call|perform|execute|run)$/.test(verb)) return mk('delegate', rawTypeFromArgs(args, bindings, locals), `${ctor.split('::').pop()}.${verb}`.slice(0, 60));
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

export interface DutyInput {
  /** The definition node. */
  def: Node;
  /** Callee capture nodes that lie inside the definition, in source order. */
  callees: Node[];
  /** Whole-file text (for bindings) and the language id. */
  text: string;
  langId: string;
  bindings: Bindings;
  /** Qualified name of a callee node when the parser already knows it (same-file defs). */
  calleeOf?: (n: Node) => string | undefined;
}

/** Ordered duties of one definition. Undefined when nothing was recognised. */
export function extractDuties(input: DutyInput): Duty[] | undefined {
  const { def, callees, langId, bindings } = input;
  if (!callees.length) return undefined;
  const bodyText = input.text.slice(def.startIndex, Math.min(def.endIndex, def.startIndex + 30_000));
  const locals = localTypes(bodyText);
  const calleeOf = input.calleeOf ?? (() => undefined);
  const out: Duty[] = [];
  const seen = new Set<string>();
  for (const callee of callees) {
    const call = callNodeOf(callee);
    if (!call) continue;
    // Nested definitions (lambdas that are their own defs) are not this body's duties.
    const duty = classifySite({ call, callee }, def, langId, bindings, locals, calleeOf);
    if (!duty) continue;
    const key = duty.k === 'respond' ? `respond|${duty.line}` : `${duty.k}|${duty.o ?? ''}|${duty.via ?? ''}|${duty.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(duty);
    if (out.length >= MAX_DUTIES) break;
  }
  // Delegations that led nowhere add noise; keep them only when they are the
  // whole story (a delegating one-liner) or point at a named collaborator.
  const real = out.filter((d) => d.k !== 'delegate');
  const delegates = out.filter((d) => d.k === 'delegate' && d.via && /[A-Z]\w*\.|\./.test(d.via));
  const kept = [...real, ...delegates].sort((a, b) => a.line - b.line || a.k.localeCompare(b.k));
  return kept.length ? kept : undefined;
}

/** Effect-style counts derived from duties (own sites only), for consumers of `node.effects`. */
export function summarizeDuties(duties: Duty[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const d of duties) {
    if (d.hop) continue;
    const key = d.k === 'persist' ? 'sqlWrite' : d.k === 'query' ? 'sql' : d.k === 'publish' ? 'msg' : d.k;
    if (key === 'delegate') continue;
    out[key] = (out[key] ?? 0) + (d.live ? 1 : 0);
  }
  return out;
}
