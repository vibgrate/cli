/**
 * Body effects — what a callable's body *calls*, scanned from its source text.
 *
 * The architecture classifier used to see only names: folder tokens, the
 * symbol name, callee names, type names. That answers "what do the names
 * claim this is for?", never "what runs when this is called?". This scanner
 * gives the graph a small, deterministic effect profile per callable so the
 * classifier can score `persist` because the body calls `SaveChangesAsync`,
 * `network_io` because it calls `fetch(`, `render` because it returns JSX —
 * and so a controller that writes straight to the store shows the leak.
 *
 * It is a bounded regex scan over the definition's own text with comments
 * removed — not a parser, not a type checker, no execution. Every count is
 * a number of matching sites; `apis` names the first few matched calls so
 * the evidence is inspectable. Same source in → same profile out.
 *
 * Deliberately conservative: a generic verb (`.get(`, `.create(`, `.send(`)
 * only counts when its receiver looks like a store, a client, or a queue;
 * strong verbs (`SaveChangesAsync`, `findUnique`, `fetch(`) count on their own.
 */

export interface CallableEffects {
  /** SQL text or ORM/store reads: `SELECT`, `.findMany(`, `ToListAsync(`. */
  sql?: number;
  /** SQL/ORM writes: `INSERT`, `.save(`, `SaveChangesAsync(`, `session.commit(`. */
  sqlWrite?: number;
  /** Outbound HTTP / RPC client calls: `fetch(`, `axios.`, `httpClient.GetAsync(`. */
  http?: number;
  /** Sending an HTTP response: `res.json(`, `return Ok(`, `jsonify(`. */
  respond?: number;
  /** File-system access. */
  fs?: number;
  /** Authentication primitives: password verify/hash, JWT, sign-in. */
  auth?: number;
  /** Cryptography beyond passwords: hashing, ciphers, random. */
  crypto?: number;
  /** Publishing to a queue / bus / event emitter. */
  msg?: number;
  /** Cache reads/writes. */
  cache?: number;
  /** Logging / tracing / metrics calls. */
  log?: number;
  /** UI rendering: JSX, templates, `render(`. */
  render?: number;
  /** Validation calls and validation-typed throws. */
  validate?: number;
  /** Call sites (fan-out). */
  calls: number;
  /** Branch points: if / else if / switch / case / match. */
  branches: number;
  loops: number;
  awaits: number;
  throws: number;
  returns: number;
  /** Assignments to member / instance state (`this.x =`, `self.x =`, `@x =`). */
  assigns: number;
  lines: number;
  /** Up to 8 distinct matched API tokens, sorted (`fetch`, `SaveChangesAsync`). */
  apis?: string[];
}

const MAX_BODY_CHARS = 30_000;
const MAX_APIS = 8;

/**
 * Receivers that make a generic verb a store call: a word that is, or ends
 * in, a store-shaped name (`productRepository`, `_context`, `db`, `prisma`).
 * Up to two member hops may follow (`_context.Products.Add(`).
 */
const STORE_RECEIVER =
  '(?:\\w*(?:[Rr]epositor(?:y|ies)|[Rr]epos?|[Dd]ao|[Ss]tore|[Cc]ontext|[Ss]ession|[Cc]ollection|[Mm]odel|[Tt]able|[Dd]atabase|[Cc]onnection|[Cc]ursor|[Tt]ransaction|[Ee]ntityManager|[Mm]anager|[Qq]uery(?:set)?|[Oo]bjects|[Dd]b|DB|[Ee]ntities|[Cc]lient|[Oo]rm)|_?(?:prisma|knex|sequelize|mongoose|conn|cur|em|qs|tx|dbSet|typeorm|drizzle|supabase|firestore|mongo|collection|redis))';
const STORE_RECEIVER_RE = new RegExp(`\\b${STORE_RECEIVER}(?:\\.\\w+){0,2}\\.(\\w+)\\s*\\(`, 'g');

const READ_VERBS = new Set([
  'find', 'findOne', 'findMany', 'findAll', 'findFirst', 'findById', 'findByPk', 'findUnique', 'findOneBy',
  'findAndCount', 'findAndCountAll', 'get', 'getAll', 'getOne', 'getMany', 'getById', 'query', 'select',
  'where', 'filter', 'first', 'all', 'count', 'exists', 'aggregate', 'fetch', 'load', 'read', 'scan',
  'search', 'list', 'lookup', 'exec', 'execute', 'raw', 'ToListAsync', 'ToArrayAsync', 'FirstOrDefaultAsync',
  'FirstAsync', 'SingleOrDefaultAsync', 'SingleAsync', 'AnyAsync', 'CountAsync', 'FindAsync', 'Find',
  'Include', 'AsNoTracking', 'Where', 'Select', 'OrderBy', 'ToList', 'FirstOrDefault', 'SingleOrDefault',
  'Any', 'Count', 'findAllBy', 'findOneAndUpdate', 'getRepository', 'createQueryBuilder', 'queryOne',
  'queryAll', 'fetchOne', 'fetchAll', 'fetchone', 'fetchall', 'one', 'many', 'paginate', 'QueryRow',
  'Query', 'QueryContext', 'QueryRowContext', 'Get', 'Select', 'SelectContext', 'GetContext', 'find_by',
  'find_each', 'pluck', 'exists?', 'get_object_or_404', 'values', 'values_list', 'only', 'defer',
]);
const WRITE_VERBS = new Set([
  'save', 'saveAll', 'saveAndFlush', 'insert', 'insertOne', 'insertMany', 'create', 'createMany',
  'update', 'updateOne', 'updateMany', 'upsert', 'delete', 'deleteOne', 'deleteMany', 'deleteById',
  'remove', 'destroy', 'persist', 'merge', 'flush', 'commit', 'add', 'Add', 'AddAsync', 'AddRange',
  'AddRangeAsync', 'Update', 'Remove', 'RemoveRange', 'SaveChanges', 'SaveChangesAsync', 'bulk_create',
  'bulk_update', 'get_or_create', 'update_or_create', 'executeUpdate', 'increment', 'decrement', 'set',
  'put', 'write', 'store', 'truncate', 'drop', 'refresh', 'sync', 'push', 'Attach', 'Entry', 'Exec',
  'ExecContext', 'NamedExec', 'MustExec', 'create!', 'save!', 'update!', 'destroy!', 'delete_all',
  'update_all', 'insert_all', 'upsert_all', 'touch', 'set',
]);
/** Verbs that count as a store call even without a store-shaped receiver. */
const STRONG_READ = /\b(findOne|findMany|findAll|findFirst|findById|findByPk|findUnique|findOneBy|findAndCount(?:All)?|findAllBy|ToListAsync|ToArrayAsync|FirstOrDefaultAsync|SingleOrDefaultAsync|AnyAsync|CountAsync|FindAsync|AsNoTracking|createQueryBuilder|getRepository|fetchone|fetchall|find_by|find_each|where\s*\(|selectinload|joinedload)\s*\(?/g;
const STRONG_WRITE = /\b(saveAndFlush|saveAll|insertMany|insertOne|createMany|updateMany|deleteMany|SaveChanges(?:Async)?|AddRangeAsync|AddAsync|RemoveRange|bulk_create|bulk_update|get_or_create|update_or_create|executeUpdate|save!|update!|destroy!|create!|find_or_create_by|update_attributes?|upsert)\s*\(?/g;
const SQL_TEXT = /\b(SELECT\s+[^;'"`]{1,200}?\s+FROM\b|INSERT\s+INTO\b|UPDATE\s+[\w"`.]+\s+SET\b|DELETE\s+FROM\b|CREATE\s+(?:TABLE|INDEX)\b|ALTER\s+TABLE\b|DROP\s+TABLE\b|MERGE\s+INTO\b)/gi;
const SQL_WRITE_TEXT = /\b(INSERT\s+INTO|UPDATE\s+[\w"`.]+\s+SET|DELETE\s+FROM|CREATE\s+(?:TABLE|INDEX)|ALTER\s+TABLE|DROP\s+TABLE|MERGE\s+INTO)\b/gi;

const HTTP_OUT = /\b(fetch\s*\(|axios(?:\.\w+)?\s*[(.]|got\s*\(|ky\.\w+\s*\(|superagent|requests\.(?:get|post|put|patch|delete|head|request)\s*\(|httpx\.\w+\s*\(|aiohttp\.|urlopen\s*\(|urllib\.request|http\.(?:Get|Post|Put|Head|NewRequest|Do)\s*\(|HttpClient|httpClient\.\w+\s*\(|_httpClient\.\w+\s*\(|RestTemplate|restTemplate\.\w+\s*\(|WebClient|webClient\.\w+\s*\(|OkHttpClient|Feign|reqwest(?:::\w+)+|ureq::|XMLHttpRequest|\$\.ajax|\.(?:GetAsync|PostAsync|PutAsync|DeleteAsync|PatchAsync|PostAsJsonAsync|PutAsJsonAsync|GetStringAsync|GetFromJsonAsync|SendAsync)\s*\(|grpc\.|\.invoke\s*\(|Net::HTTP|HTTParty|Faraday|RestClient)/g;
const RESPOND = /\b(res\.(?:send|render|redirect|sendStatus|end|write)\s*\(|res\.json\s*\(\s*[^)\s]|res\.status\s*\(\s*\d|response\.(?:send|write|redirect)\s*\(|response\.json\s*\(\s*[^)\s]|response\.status\s*\(\s*\d|reply\.(?:send|code|status)\s*\(|ctx\.(?:body|status|json)\b|jsonify\s*\(|render_template\s*\(|JsonResponse\s*\(|HttpResponse\w*\s*\(|return\s+(?:Ok|NotFound|BadRequest|Created|CreatedAtAction|CreatedAtRoute|NoContent|Unauthorized|Forbid|StatusCode|Json|View|Redirect|Accepted|Conflict|Problem)\s*\(|ResponseEntity\.|render\s+json:|render\s+:|respond_to|NextResponse\.|Response\.json\s*\(|new\s+Response\s*\(|c\.JSON\s*\(|c\.String\s*\(|w\.Write(?:Header)?\s*\(|json\.NewEncoder\s*\(\s*w\s*\)|HttpResponseMessage|IActionResult)/g;
const FS_IO = /\b(fs\.\w+\s*\(|fsPromises\.\w+|readFile(?:Sync)?\s*\(|writeFile(?:Sync)?\s*\(|appendFile|mkdir(?:Sync)?\s*\(|readdir|unlink(?:Sync)?\s*\(|createReadStream|createWriteStream|os\.path\.|pathlib|shutil\.|Path\s*\([^)]*\)\s*\.\s*(?:read|write|open)|\.read_text\s*\(|\.write_text\s*\(|\.read_bytes\s*\(|\.write_bytes\s*\(|File\.(?:ReadAll\w*|WriteAll\w*|Exists|Open\w*|Delete|Copy|Move|Create)\s*\(|FileStream|StreamReader|StreamWriter|Files\.(?:read\w*|write\w*|exists|delete|copy|move|create\w*|walk|list)\s*\(|FileReader|FileWriter|BufferedReader|BufferedWriter|ioutil\.\w+\s*\(|os\.(?:Open|Create|ReadFile|WriteFile|Remove|MkdirAll|Stat)\s*\(|std::fs::|File::(?:open|create)\s*\(|IO\.(?:read|write|readlines)\s*\(|File\.(?:read|write|open|exist\?|readlines)\s*\(|Dir\.\w+\s*\(|open\s*\([^)]*['"][rwab+]{1,3}['"]\s*\))/g;
const PY_RB_OPEN = /\bopen\s*\(/g;
const AUTH = /\b(bcrypt|argon2|scrypt|pbkdf2|jwt\.\w+\s*\(|jsonwebtoken|verify_password|check_password|checkpw|hashpw|hash_password|get_password_hash|create_access_token|create_refresh_token|decode_token|verify_token|passport\.|authenticate\s*\(|login\s*\(|logout\s*\(|login_user|logout_user|OAuth|oauth|SignInAsync|SignOutAsync|PasswordHasher|UserManager|SignInManager|SecurityContext|AuthenticationManager|verifyPassword|comparePassword|compareSync\s*\(|\.compare\s*\(|hashSync\s*\(|getServerSession|getSession\s*\(|auth\s*\(|currentUser|current_user|has_secure_password|authenticate_user!|devise|Authorization|Bearer\b|api_key|apiKey)/g;
const CRYPTO = /\b(crypto\.\w+|hashlib\.\w+|sha1|sha256|sha512|md5|hmac|HMAC|createHash|createHmac|createCipher\w*|createDecipher\w*|encrypt\w*\s*\(|decrypt\w*\s*\(|AES|RSA|Cipher|randomBytes|randomUUID|secrets\.\w+|MessageDigest|SHA256|Rfc2898|RandomNumberGenerator|Fernet|nacl\.|libsodium|ring::|openssl)/g;
const MSG = /\b(publish\w*\s*\(|Publish(?:Async)?\s*\(|\.emit\s*\(|enqueue|producer\.\w+\s*\(|kafka|Kafka|rabbit|amqp|sqs\.|sns\.|pubsub|PubSub|channel\.(?:publish|sendToQueue|basicPublish)|queue\.(?:add|push|send|enqueue)\s*\(|celery|\.delay\s*\(|apply_async|bullmq|EventEmitter|eventBus|EventBus|mediator\.Publish\w*\s*\(|_mediator\.Publish\w*\s*\(|_publisher\.\w+\s*\(|_bus\.\w+\s*\(|ActiveJob|perform_later|perform_async|Sidekiq|broadcast\w*\s*\(|dispatch\s*\(|SendMessage(?:Async)?\s*\(|ServiceBus|EventGrid|MassTransit|IPublishEndpoint|rebus|NATS|nats\.|mqtt|kinesis|WebSocket|socket\.emit|io\.emit|\.sendMail\s*\(|sendEmail|send_mail|deliver_now|deliver_later|mailer|Mailer|twilio|sendgrid|nodemailer)/g;
const CACHE = /\b(redis|Redis|cache\.(?:get|set|del|delete|has|remember|fetch|wrap|clear|invalidate)\w*\s*\(|_cache\.\w+\s*\(|Cache\.|IMemoryCache|IDistributedCache|memcache|lru_cache|lru\.|memoize|memo\s*\(|useMemo\s*\(|Rails\.cache|cache_page|@cache|@Cacheable|@CacheEvict|CacheManager)/g;
const LOG = /\b(logger\.\w+\s*\(|_logger\.\w+\s*\(|log\.(?:info|warn|warning|error|debug|trace|fatal|critical)\w*\s*\(|console\.(?:log|warn|error|info|debug|trace)\s*\(|logging\.\w+\s*\(|Log\.\w+\s*\(|Logger\.\w+\s*\(|slf4j|log4j|tracing::|log::(?:info|warn|error|debug|trace)!|println!|eprintln!|Rails\.logger|puts\s|logger\s*\.|winston|pino|tracer\.\w+\s*\(|span\.\w+\s*\(|metrics\.\w+\s*\(|Metrics\.\w+\s*\(|Sentry\.\w+\s*\(|captureException|Telemetry|ILogger)/g;
const RENDER_JSX = /<(?:[A-Z][\w.]*|div|span|p|a|ul|ol|li|button|form|input|label|section|header|footer|main|nav|table|tr|td|th|h[1-6]|img|svg|select|option|textarea|article|aside|dialog|Fragment)\b[^>]*>|<>/g;
const RENDER = /\b(render\s*\(|renderToString|ReactDOM\.\w+|createElement\s*\(|res\.render\s*\(|render_template\s*\(|\.render\s*\(|template\.\w+\s*\(|Template\s*\(|html`|@Composable|setContent\s*\{|Widget\s+build\s*\(|return\s+View\s*\(|PartialView\s*\(|Html\.\w+\s*\(|innerHTML|document\.(?:createElement|getElementById|querySelector)\w*\s*\(|useState\s*\(|useEffect\s*\(|useRef\s*\(|useCallback\s*\(|useContext\s*\(|useRouter\s*\(|useQuery\s*\(|useMutation\s*\(|useForm\s*\(|useSelector\s*\(|useDispatch\s*\(|useTranslation\s*\(|Widget\b|StatelessWidget|StatefulWidget|SwiftUI|UIView|NSView|@Component|template:|styleUrls|render_to_response|mark_safe|format_html|erb|haml|slim|jinja|Blade|\.blade\.)/g;
const VALIDATE = /\b(validate\w*\s*\(|Validate\w*\s*\(|validator\.|Validator\.|schema\.(?:parse|safeParse|validate|validateSync|parseAsync)\s*\(|z\.\w+\s*\(|zod|yup\.|Joi\.|joi\.|class-validator|validateOrReject|ValidationError|ValidationException|ValidationProblem|BadRequestException|UnprocessableEntity|ArgumentException|ArgumentNullException|ArgumentOutOfRangeException|InvalidOperationException|ValueError|TypeError\s*\(|assert\s*\(|assert\s+\w|invariant\s*\(|@Valid|@Validated|is_valid\s*\(|full_clean|\.valid\?|validates\s|ModelState\.IsValid|IsValid|RuleFor\s*\(|FluentValidation|ensure\w*\s*\(|check\w*\s*\(|guard\s+(?:let|var)|require\s*\(\s*[^'"]|precondition\s*\(|Guard\.\w+\s*\(|Ensure\.\w+\s*\(|throw\s+new\s+\w*(?:Validation|Argument|Invalid|BadRequest|Unprocessable)\w*)/g;

const BRANCH = /\b(if|else\s+if|elif|elsif|switch|case|match|when|unless|\?\?|catch|except|rescue)\b/g;
const LOOP = /\b(for|while|foreach|loop|until|do)\b|\.(?:forEach|map|flatMap|filter|reduce|each|each_with_index|times|select|reject|collect)\s*\(|\.(?:each|map|select|reject|collect)\s*(?:\{|do\b)/g;
const AWAIT = /\b(await|\.then\s*\(|\.subscribe\s*\(|\.Result\b|\.Wait\s*\(|\.GetAwaiter\s*\(|yield\s+from|asyncio\.\w+|Task\.WhenAll|Promise\.all|Promise\.allSettled|\.await\b)/g;
const THROW = /\b(throw|raise|panic!?|rethrow|fail\s*\()/g;
const RETURN = /\breturn\b/g;
const ASSIGN = /(?:\bthis\.|\bself\.|@|\b_|\bthis->|\bself->)\w+\s*(?:[+\-*/|&]?=)(?!=)/g;
const CALL = /\b([A-Za-z_$][\w$]*)\s*\(/g;
const CALL_KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'new', 'typeof', 'await', 'async', 'else',
  'elif', 'except', 'with', 'match', 'case', 'when', 'unless', 'until', 'do', 'foreach', 'lock', 'using',
  'sizeof', 'defer', 'go', 'select', 'yield', 'print', 'echo', 'and', 'or', 'not', 'in', 'is', 'as',
  'super', 'this', 'self', 'throw', 'raise', 'assert', 'require', 'import', 'from', 'def', 'fn', 'fun',
  'func', 'class', 'interface', 'struct', 'enum', 'delete', 'void', 'int', 'string', 'bool', 'float',
  'double', 'long', 'char', 'byte', 'var', 'let', 'const', 'static', 'public', 'private', 'protected',
]);

const PY_RB_COMMENT_LANGS = new Set(['py', 'rb', 'sh', 'bash', 'ex', 'elixir', 'lua', 'r', 'yaml', 'toml']);
const JSX_LANGS = new Set(['tsx', 'jsx', 'js', 'vue', 'svelte', 'astro']);

/** Remove comments so a `// TODO: fetch from the API` never counts as a call. */
export function stripComments(text: string, langId: string): string {
  let out = text.replace(/\/\*[\s\S]*?\*\//g, ' ');
  if (PY_RB_COMMENT_LANGS.has(langId)) {
    out = out.replace(/(^|[^\w'":`\\])#[^\n]*/g, '$1');
    // Python docstrings.
    out = out.replace(/"""[\s\S]*?"""|'''[\s\S]*?'''/g, ' ');
  } else if (langId !== 'sql') {
    out = out.replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
  }
  return out;
}

function countMatches(text: string, re: RegExp, apis?: Set<string>, keep = false): number {
  re.lastIndex = 0;
  let n = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    n++;
    if (keep && apis) {
      const token = (m[1] ?? m[0]).replace(/[\s(.:!{]+$/g, '').replace(/^\./, '');
      if (token && token.length <= 40) apis.add(token);
    }
    if (m[0].length === 0) re.lastIndex++;
  }
  return n;
}

/** Store-shaped receiver calls split into reads and writes. */
function storeCalls(text: string, apis: Set<string>): { reads: number; writes: number } {
  let reads = 0;
  let writes = 0;
  STORE_RECEIVER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = STORE_RECEIVER_RE.exec(text)) !== null) {
    const verb = m[1] ?? '';
    if (WRITE_VERBS.has(verb)) {
      writes++;
      apis.add(`${m[0].split('.')[0]}.${verb}`);
    } else if (READ_VERBS.has(verb)) {
      reads++;
      apis.add(`${m[0].split('.')[0]}.${verb}`);
    }
  }
  return { reads, writes };
}

function countCalls(text: string): number {
  CALL.lastIndex = 0;
  let n = 0;
  let m: RegExpExecArray | null;
  while ((m = CALL.exec(text)) !== null) {
    if (!CALL_KEYWORDS.has(m[1]!)) n++;
  }
  return n;
}

/**
 * Effect profile of one definition's text (signature + body). Returns
 * undefined for an empty body so the graph stays compact for declarations.
 */
export function scanEffects(defText: string, langId: string): CallableEffects | undefined {
  if (!defText) return undefined;
  const clipped = defText.length > MAX_BODY_CHARS ? defText.slice(0, MAX_BODY_CHARS) : defText;
  const text = stripComments(clipped, langId);
  // Skip the header so parameter types (`Request`) don't read as calls. A
  // definition with neither a brace nor a second line has no body.
  let bodyStart = Math.max(text.indexOf('{'), text.indexOf(':\n'), text.indexOf('\n'));
  // Expression-bodied members (`public int Total() => Items.Sum(i => i.Price);`).
  if (bodyStart < 0) bodyStart = text.indexOf('=>');
  if (bodyStart < 0) return undefined;
  const body = text.slice(bodyStart);
  if (!body.trim()) return undefined;

  const apis = new Set<string>();
  const store = storeCalls(body, apis);
  const sqlText = countMatches(body, SQL_TEXT, apis, true);
  const sqlWriteText = countMatches(body, SQL_WRITE_TEXT);
  const strongRead = countMatches(body, STRONG_READ, apis, true);
  const strongWrite = countMatches(body, STRONG_WRITE, apis, true);

  const e: CallableEffects = {
    calls: countCalls(body),
    branches: countMatches(body, BRANCH),
    loops: countMatches(body, LOOP),
    awaits: countMatches(body, AWAIT),
    throws: countMatches(body, THROW),
    returns: countMatches(body, RETURN),
    assigns: countMatches(body, ASSIGN),
    lines: body.split('\n').length,
  };
  const set = (key: keyof CallableEffects, n: number): void => {
    if (n > 0) (e as unknown as Record<string, number>)[key] = n;
  };
  set('sql', store.reads + strongRead + (sqlText - sqlWriteText));
  set('sqlWrite', store.writes + strongWrite + sqlWriteText);
  set('http', countMatches(body, HTTP_OUT, apis, true));
  set('respond', countMatches(body, RESPOND, apis, true));
  let fsN = countMatches(body, FS_IO, apis, true);
  if (langId === 'py' || langId === 'rb') fsN += countMatches(body, PY_RB_OPEN, apis, true);
  set('fs', fsN);
  set('auth', countMatches(body, AUTH, apis, true));
  set('crypto', countMatches(body, CRYPTO, apis, true));
  set('msg', countMatches(body, MSG, apis, true));
  set('cache', countMatches(body, CACHE, apis, true));
  set('log', countMatches(body, LOG));
  let render = countMatches(body, RENDER, apis, true);
  if (JSX_LANGS.has(langId)) render += countMatches(body, RENDER_JSX);
  set('render', render);
  set('validate', countMatches(body, VALIDATE, apis, true));
  if (apis.size) e.apis = [...apis].sort().slice(0, MAX_APIS);
  return e;
}
