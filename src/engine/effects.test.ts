import { describe, expect, it } from 'vitest';
import { scanEffects, stripComments } from './effects.js';

/**
 * The effect scanner reads what a body executes. Each case is a real-shaped
 * snippet from a language in the test pack; the assertions are the effects
 * a reader would name, and the ones that must NOT fire (a `// fetch` comment,
 * `res.send` as messaging, a parameter type as a call).
 */

describe('scanEffects', () => {
  it('reads a C# EF Core command handler as a write via the db context', () => {
    const e = scanEffects(
      `public async Task<int> Handle(CreateProductCommand request, CancellationToken cancellationToken)
      {
          var entity = new Product { Name = request.Name, Price = request.Price };
          _context.Products.Add(entity);
          await _context.SaveChangesAsync(cancellationToken);
          _logger.LogInformation("Created {Id}", entity.Id);
          return entity.Id;
      }`,
      'cs',
    )!;
    expect(e.sqlWrite).toBeGreaterThanOrEqual(2);
    expect(e.sql).toBeUndefined();
    expect(e.log).toBe(1);
    expect(e.awaits).toBe(1);
    expect(e.returns).toBe(1);
    expect(e.apis).toContain('SaveChangesAsync');
    expect(e.apis).toContain('_context.Add');
  });

  it('reads an EF Core query handler as a read', () => {
    const e = scanEffects(
      `public async Task<ProductDto?> Handle(GetProductByIdQuery request, CancellationToken ct)
      {
          var p = await _context.Products.AsNoTracking().FirstOrDefaultAsync(x => x.Id == request.Id, ct);
          if (p is null) return null;
          return new ProductDto(p.Id, p.Name);
      }`,
      'cs',
    )!;
    expect(e.sql).toBeGreaterThanOrEqual(1);
    expect(e.sqlWrite).toBeUndefined();
    expect(e.branches).toBe(1);
  });

  it('reads a TS fetch helper as outbound HTTP, not persistence', () => {
    const e = scanEffects(
      `async function fetchApi<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
        // TODO: retry on 503 — never fetch twice for now
        const res = await fetch(\`\${BASE}\${endpoint}\`, { ...options, headers: { 'Content-Type': 'application/json' } });
        if (!res.ok) throw new ApiError(res.status, await res.text());
        return res.json();
      }`,
      'ts',
    )!;
    expect(e.http).toBe(1);
    expect(e.sql).toBeUndefined();
    expect(e.sqlWrite).toBeUndefined();
    // `res.json()` on a fetch Response is not an HTTP response being sent.
    expect(e.respond).toBeUndefined();
    expect(e.throws).toBe(1);
    expect(e.apis).toContain('fetch');
  });

  it('reads an Express controller as responding, and res.send is not messaging', () => {
    const e = scanEffects(
      `async create(req: Request, res: Response): Promise<void> {
        const dto = req.body;
        const article = await this.service.create(dto);
        res.status(201).json(article);
      }`,
      'ts',
    )!;
    expect(e.respond).toBeGreaterThanOrEqual(1);
    expect(e.msg).toBeUndefined();
    expect(e.http).toBeUndefined();
    expect(e.awaits).toBe(1);
  });

  it('reads a Prisma service call as a store write', () => {
    const e = scanEffects(
      `async create(dto: CreateMediaDto): Promise<Media> {
        const media = await prisma.media.create({ data: dto });
        await this.cache.del('media:list');
        return media;
      }`,
      'ts',
    )!;
    expect(e.sqlWrite).toBe(1);
    expect(e.cache).toBe(1);
    expect(e.apis).toContain('prisma.create');
  });

  it('reads a Python SQLAlchemy service and a bcrypt helper', () => {
    const svc = scanEffects(
      `async def create(self, user_in: UserCreate) -> User:
        """Create a new user."""
        user = User(email=user_in.email, hashed_password=get_password_hash(user_in.password))
        self.db.add(user)
        await self.db.commit()
        await self.db.refresh(user)
        return user`,
      'py',
    )!;
    expect(svc.sqlWrite).toBeGreaterThanOrEqual(2);
    expect(svc.auth).toBe(1);
    expect(svc.awaits).toBe(2);
    const hash = scanEffects(
      `def get_password_hash(password: str) -> str:
        return pwd_context.hash(password)  # bcrypt`,
      'py',
    )!;
    // The comment is stripped; the call itself is a plain call.
    expect(hash.auth).toBeUndefined();
    expect(hash.calls).toBe(1);
    const verify = scanEffects(
      `def verify_password(plain: str, hashed: str) -> bool:
        return bcrypt.checkpw(plain.encode(), hashed.encode())`,
      'py',
    )!;
    expect(verify.auth).toBeGreaterThanOrEqual(1);
  });

  it('reads a Python file writer and a raw SQL query', () => {
    const w = scanEffects(
      `def export_report(path, rows):
        with open(path, "w") as f:
            for row in rows:
                f.write(row)`,
      'py',
    )!;
    expect(w.fs).toBeGreaterThanOrEqual(1);
    expect(w.loops).toBe(1);
    const q = scanEffects(
      `def count_active(conn):
        cur = conn.cursor()
        cur.execute("SELECT count(*) FROM users WHERE active = 1")
        return cur.fetchone()[0]`,
      'py',
    )!;
    expect(q.sql).toBeGreaterThanOrEqual(2);
    expect(q.sqlWrite).toBeUndefined();
  });

  it('reads a Java Spring service that logs and saves through a repository', () => {
    const e = scanEffects(
      `@Override
      @Transactional
      public ProductDTO createProduct(CreateProductRequest request) {
          log.info("Creating product {}", request.getName());
          if (productRepository.existsBySku(request.getSku())) {
              throw new IllegalArgumentException("SKU exists");
          }
          Product saved = productRepository.save(toEntity(request));
          eventPublisher.publishEvent(new ProductCreated(saved.getId()));
          return toDTO(saved);
      }`,
      'java',
    )!;
    expect(e.sqlWrite).toBe(1);
    expect(e.log).toBe(1);
    expect(e.msg).toBe(1);
    expect(e.throws).toBe(1);
    expect(e.branches).toBe(1);
    expect(e.apis).toContain('productRepository.save');
  });

  it('reads a React component as rendering', () => {
    const e = scanEffects(
      `export function ProductCard({ product }: ProductCardProps) {
        const [open, setOpen] = useState(false);
        return (
          <div className="card">
            <h2>{product.name}</h2>
            <button onClick={() => setOpen(!open)}>Details</button>
          </div>
        );
      }`,
      'tsx',
    )!;
    expect(e.render).toBeGreaterThanOrEqual(3);
    expect(e.http).toBeUndefined();
  });

  it('reads a Rails migration and a Go handler', () => {
    const rb = scanEffects(
      `def change
        create_table :posts do |t|
          t.string :title
          t.timestamps
        end
      end`,
      'rb',
    );
    // Ruby's paren-less calls are not counted as calls; the body is still profiled.
    expect(rb?.lines).toBeGreaterThanOrEqual(5);
    const go = scanEffects(
      `func (h *Handler) GetUser(w http.ResponseWriter, r *http.Request) {
        id := chi.URLParam(r, "id")
        u, err := h.db.QueryRow("SELECT id, name FROM users WHERE id = $1", id)
        if err != nil {
          w.WriteHeader(http.StatusNotFound)
          return
        }
        json.NewEncoder(w).Encode(u)
      }`,
      'go',
    )!;
    expect(go.sql).toBeGreaterThanOrEqual(1);
    expect(go.respond).toBeGreaterThanOrEqual(1);
    expect(go.branches).toBe(1);
  });

  it('reads an expression-bodied C# member and does not call MediatR Send a message', () => {
    const one = scanEffects('public Task<Product?> GetByIdAsync(int id) => _context.Products.FirstOrDefaultAsync(p => p.Id == id);', 'cs')!;
    expect(one.sql).toBeGreaterThanOrEqual(1);
    const ctl = scanEffects(
      `public async Task<ActionResult<int>> Create(CreateProductCommand command)
      {
          var id = await _mediator.Send(command);
          _mediator.Publish(new ProductCreated(id));
          return CreatedAtAction(nameof(GetById), new { id }, id);
      }`,
      'cs',
    )!;
    expect(ctl.msg).toBe(1);
    expect(ctl.respond).toBe(1);
  });

  it('never counts a parameter type or a comment as an effect', () => {
    const e = scanEffects(
      `function noop(req: Request, client: HttpClient): void {
        // fetch(url) would go here; axios.get too
        /* prisma.user.create({}) */
        return;
      }`,
      'ts',
    )!;
    expect(e.http).toBeUndefined();
    expect(e.sqlWrite).toBeUndefined();
    expect(e.calls).toBe(0);
    expect(e.returns).toBe(1);
  });

  it('returns undefined for an empty body, is deterministic, and caps apis at 8', () => {
    expect(scanEffects('', 'ts')).toBeUndefined();
    expect(scanEffects('function x(): void', 'ts')).toBeUndefined();
    const body = `function many() {\n${['fetch(a)', 'axios.get(b)', 'redis.get(c)', 'logger.info(d)', 'bcrypt.hash(e)', 'jwt.sign(f)', 'crypto.randomUUID()', 'publish(g)', 'queue.add(h)', 'fs.readFileSync(i)', 'sha256(j)'].join(';\n')}\n}`;
    const a = scanEffects(body, 'ts')!;
    const b = scanEffects(body, 'ts')!;
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.apis!.length).toBeLessThanOrEqual(8);
    expect([...a.apis!]).toEqual([...a.apis!].sort());
  });

  it('strips comments per language family', () => {
    expect(stripComments('a() // b()\nc()', 'ts')).toBe('a() \nc()');
    expect(stripComments('a() # b()\nc()', 'py')).toBe('a() \nc()');
    expect(stripComments('x = "http://h" // keep', 'ts')).toBe('x = "http://h" ');
    expect(stripComments('/* a() */ b()', 'java')).toBe('  b()');
  });
});
