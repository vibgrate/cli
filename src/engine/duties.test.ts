import { describe, expect, it } from 'vitest';
import { parseSource } from './parse.js';
import { fileBindings } from './duties.js';
import type { Duty } from './duties.js';

/**
 * Duty IR on real-shaped bodies. Each case parses a file with the real
 * tree-sitter grammar and asserts the ordered duties a reader would name —
 * and the ones that must not appear: a dead write after `return`, a
 * catch-only log on the happy path, a fetch `Response.json()` mistaken for
 * an HTTP response, MediatR `Send` mistaken for a publish.
 */

async function dutiesOf(lang: string, file: string, source: string, name: string): Promise<Duty[]> {
  const parsed = await parseSource(file, lang, source);
  const def = parsed.defs.find((d) => d.name === name);
  if (!def) throw new Error(`no def ${name} in ${parsed.defs.map((d) => d.name).join(',')}`);
  return def.duties ?? [];
}

const kinds = (d: Duty[]): string[] => d.map((x) => x.k);

describe('duties: typed receivers', () => {
  it('reads an unconventionally named field as a store because of its declared type', async () => {
    const src = `
using System;
public class ProductsController {
    private readonly IProductRepository catalog;
    private readonly ILogger<ProductsController> _logger;
    public ProductsController(IProductRepository catalog, ILogger<ProductsController> logger) { this.catalog = catalog; _logger = logger; }

    public async Task<IActionResult> Create(CreateProductDto dto, CancellationToken ct)
    {
        var product = new Product(dto.Name);
        await catalog.AddAsync(product, ct);
        _logger.LogInformation("created");
        return CreatedAtAction(nameof(Get), new { id = product.Id }, product);
    }
}`;
    const d = await dutiesOf('cs', 'Api/ProductsController.cs', src, 'Create');
    expect(kinds(d)).toEqual(['persist', 'log', 'respond']);
    expect(d[0]).toMatchObject({ k: 'persist', o: 'Product', via: 'catalog.AddAsync', live: true });
    expect(d[2]).toMatchObject({ k: 'respond', o: '201', live: true });
  });

  it('binds a TypeScript constructor-injected collaborator by its type', async () => {
    const src = `
export class OrdersController {
  constructor(private readonly orders: OrderRepository, private readonly bus: EventBus) {}

  async create(req: Request, res: Response): Promise<void> {
    const order = await this.orders.save(req.body);
    this.bus.publish(new OrderCreated(order.id));
    res.status(201).json(order);
  }
}`;
    const d = await dutiesOf('ts', 'src/orders.controller.ts', src, 'create');
    expect(kinds(d)).toEqual(['persist', 'publish', 'respond']);
    expect(d[1]).toMatchObject({ k: 'publish', o: 'OrderCreated' });
    expect(d[2]).toMatchObject({ k: 'respond', o: '201' });
  });

  it('a variable spelled like a store but typed as an HTTP context is not a store', async () => {
    const src = `
public class Middleware {
    public async Task Invoke(HttpContext context)
    {
        await context.Response.WriteAsync("ok");
    }
}`;
    const d = await dutiesOf('cs', 'Middleware.cs', src, 'Invoke');
    expect(kinds(d)).not.toContain('persist');
  });
});

describe('duties: control flow', () => {
  it('a write after return is dead, a write under a dry-run guard carries the guard', async () => {
    const src = `
export class Sync {
  constructor(private readonly repo: UserRepository) {}
  async run(dryRun: boolean): Promise<number> {
    if (dryRun) return 0;
    await this.repo.save({ id: 1 });
    return 1;
    await this.repo.delete(1);
  }
  never(): void {
    if (false) { this.repo.save({}); }
  }
}`;
    const run = await dutiesOf('ts', 'sync.ts', src, 'run');
    expect(run.map((d) => [d.k, d.live, d.g])).toEqual([
      ['persist', true, 'unless dryRun'],
      ['persist', false, undefined],
    ]);
    const never = await dutiesOf('ts', 'sync.ts', src, 'never');
    expect(never).toEqual([expect.objectContaining({ k: 'persist', live: false, g: 'false' })]);
  });

  it('a catch-only log is the failure path, not the happy path', async () => {
    const src = `
def charge(self, order):
    try:
        self.gateway.post("/charges", order)
    except Exception as exc:
        self.logger.error("charge failed", exc)
        raise
`;
    const d = await dutiesOf('py', 'billing.py', src, 'charge');
    const http = d.find((x) => x.k === 'http');
    const log = d.find((x) => x.k === 'log');
    expect(http).toMatchObject({ live: true, o: '/charges' });
    expect(log).toMatchObject({ live: false, g: 'catch' });
  });
});

describe('duties: what is not a duty', () => {
  it('a fetch Response.json() is not an HTTP response being sent', async () => {
    const src = `
export async function fetchApi<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(\`\${BASE}\${endpoint}\`, options);
  if (!res.ok) throw new ApiError(res.status);
  return res.json();
}`;
    const d = await dutiesOf('ts', 'api.ts', src, 'fetchApi');
    expect(kinds(d)).toContain('http');
    expect(kinds(d)).not.toContain('respond');
  });

  it('MediatR Send is a delegation, Publish is a publish', async () => {
    const src = `
public class ProductsController {
    private readonly IMediator _mediator;
    public async Task<IActionResult> Create(CreateProductCommand cmd)
    {
        var id = await _mediator.Send(cmd);
        await _mediator.Publish(new ProductCreated(id));
        return Ok(id);
    }
}`;
    const d = await dutiesOf('cs', 'ProductsController.cs', src, 'Create');
    expect(kinds(d)).toEqual(['delegate', 'publish', 'respond']);
    expect(d[1]).toMatchObject({ o: 'ProductCreated' });
    expect(d[2]).toMatchObject({ o: '200' });
  });

  it('a service call is a delegation the inherit pass can follow', async () => {
    const src = `
public class ProductsController {
    private readonly IProductService _products;
    public Task<IActionResult> Create(CreateProductDto dto) => _products.Create(dto);
}`;
    const d = await dutiesOf('cs', 'ProductsController.cs', src, 'Create');
    expect(d).toEqual([expect.objectContaining({ k: 'delegate', via: 'IProductService.Create', o: 'CreateProductDto', t: 'IProductService' })]);
  });
});

describe('duties: languages', () => {
  it('Python SQLAlchemy session writes and a password hash', async () => {
    const src = `
class UserService:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def create(self, user_in: UserCreate) -> User:
        user = User(email=user_in.email, hashed_password=get_password_hash(user_in.password))
        self.db.add(user)
        await self.db.commit()
        return user
`;
    const d = await dutiesOf('py', 'app/services/user_service.py', src, 'create');
    expect(kinds(d)).toEqual(['auth', 'persist', 'persist']);
    expect(d[1]).toMatchObject({ k: 'persist', o: 'User', via: 'db.add' });
  });

  it('Prisma $transaction and a Java Spring repository save', async () => {
    const ts = `
export async function moveStock(prisma: PrismaClient, from: string, to: string) {
  await prisma.$transaction([prisma.stock.update({ where: { id: from } }), prisma.stock.update({ where: { id: to } })]);
}`;
    const d = await dutiesOf('ts', 'stock.ts', ts, 'moveStock');
    expect(kinds(d)).toContain('persist');
    const java = `
@Service
public class ProductServiceImpl implements ProductService {
    private final ProductRepository productRepository;
    private final ApplicationEventPublisher publisher;

    @Override
    public ProductDTO createProduct(CreateProductRequest request) {
        if (productRepository.existsBySku(request.getSku())) {
            throw new IllegalArgumentException("SKU exists");
        }
        Product saved = productRepository.save(toEntity(request));
        publisher.publishEvent(new ProductCreated(saved.getId()));
        return toDTO(saved);
    }
}`;
    const j = await dutiesOf('java', 'ProductServiceImpl.java', java, 'createProduct');
    expect(kinds(j)).toEqual(['query', 'persist', 'publish']);
    expect(j[0]).toMatchObject({ k: 'query', o: 'Product' });
    expect(j[0]!.g).toBeUndefined();
    expect(j[1]).toMatchObject({ k: 'persist', o: 'Product', via: 'productRepository.save', g: 'unless existsBySku(…)' });
    expect(j[2]).toMatchObject({ k: 'publish', o: 'ProductCreated' });
  });

  it('Ruby paren-less save! and render', async () => {
    const src = `
class PostsController < ApplicationController
  def create
    @post = Post.new(post_params)
    @post.save!
    render json: @post, status: :created
  end
end
`;
    const d = await dutiesOf('rb', 'app/controllers/posts_controller.rb', src, 'create');
    expect(kinds(d)).toContain('persist');
  });
});

describe('fileBindings', () => {
  it('reads C#, TS and Python declarations', () => {
    const cs = fileBindings('private readonly IProductRepository _products; public X(ILogger<X> logger) {}', 'cs');
    expect(cs.get('_products')).toBe('IProductRepository');
    expect(cs.get('products')).toBe('IProductRepository');
    expect(cs.get('logger')).toBe('ILogger<X>');
    const ts = fileBindings('constructor(private readonly orders: OrderRepository, bus: EventBus) {}', 'ts');
    expect(ts.get('orders')).toBe('OrderRepository');
    expect(ts.get('bus')).toBe('EventBus');
    const py = fileBindings('def __init__(self, db: AsyncSession):\n    self.db = db\n    self.cache = RedisCache()', 'py');
    expect(py.get('db')).toBe('AsyncSession');
    expect(py.get('cache')).toBe('RedisCache');
  });
});

describe('duties: Rails, Django and typed clients', () => {
  it('reads a Rails action: a bare model finder is a query, `render json:` is the response', async () => {
    const src = `
class PostsController < ApplicationController
  def show
    @post = Post.find(params[:id])
    render json: @post
  end

  def create
    @post = Post.new(post_params)
    @post.save!
    render json: @post, status: :created
  end

  def publish
    PostPublisher.new(@post).call
    redirect_to @post
  end
end`;
    const show = await dutiesOf('rb', 'app/controllers/posts_controller.rb', src, 'show');
    expect(show.map((d) => [d.k, d.o, d.via])).toEqual([
      ['query', 'Post', 'Post.find'],
      ['respond', '200', 'render'],
    ]);
    const create = await dutiesOf('rb', 'app/controllers/posts_controller.rb', src, 'create');
    expect(create.map((d) => [d.k, d.o])).toEqual([
      ['persist', 'Post'],
      ['respond', '201'],
    ]);
    // `PostPublisher.new(@post).call` is `PostPublisher.call` for the inherit pass.
    const publish = await dutiesOf('rb', 'app/controllers/posts_controller.rb', src, 'publish');
    expect(publish.map((d) => [d.k, d.via, d.o])).toEqual([
      ['delegate', 'PostPublisher.call', 'Post'],
      ['respond', 'redirect_to', '302'],
    ]);
  });

  it('names the instance, not the value, on a bang write; a mailer deliver is a publish', async () => {
    const src = `
class PostPublisher
  def initialize(post)
    @post = post
  end

  def call
    @post.update!(published_at: Time.current)
    PostMailer.published(@post).deliver_later
  end
end`;
    const d = await dutiesOf('rb', 'app/services/post_publisher.rb', src, 'call');
    expect(d[0]).toMatchObject({ k: 'persist', o: 'Post', via: 'update!' });
    expect(kinds(d)).toContain('publish');
  });

  it('reads Django `Model.objects` as the store and names the model', async () => {
    const src = `
class UserService:
    def actives(self):
        return list(User.objects.filter(active=True))

    def promote(self, user_id):
        User.objects.filter(id=user_id).update(role="admin")
`;
    const d = await dutiesOf('py', 'app/services.py', src, 'actives');
    expect(d[0]).toMatchObject({ k: 'query', o: 'User' });
    const p = await dutiesOf('py', 'app/services.py', src, 'promote');
    expect(p.find((d) => d.k === 'persist')).toMatchObject({ o: 'User' });
  });

  it('counts any method on a receiver declared as an HTTP client as calling out', async () => {
    const src = `
public class OrderService {
    private final PaymentClient paymentClient;
    public OrderService(PaymentClient paymentClient) { this.paymentClient = paymentClient; }

    public Order place(Order order) {
        paymentClient.charge(order.getId(), order.getTotal());
        return order;
    }
}`;
    const d = await dutiesOf('java', 'src/main/java/app/OrderService.java', src, 'place');
    expect(d[0]).toMatchObject({ k: 'http', t: 'PaymentClient', via: 'paymentClient.charge', live: true });
  });

  it('keeps Python decorators beside the signature, out of the id hash', async () => {
    const src = `
router = APIRouter()

@router.post("/login")
def login(form_data, service: UserService):
    return service.authenticate(form_data.username, form_data.password)
`;
    const parsed = await parseSource('app/api.py', 'py', src);
    const def = parsed.defs.find((d) => d.name === 'login')!;
    expect(def.signature).toBe('def login(form_data, service: UserService)');
    expect(def.decorators).toBe('@router.post("/login")');
  });
});
