import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { scanDatabaseSchema } from './database-schema.js';
import type { ProjectScan, DependencyRow } from '../../core-open/index.js';

function makeProject(name: string, projectPath: string, deps: DependencyRow[] = []): ProjectScan {
  return {
    type: 'node',
    path: projectPath,
    name,
    frameworks: [],
    dependencies: deps,
    dependencyAgeBuckets: { current: 0, oneBehind: 0, twoPlusBehind: 0, unknown: 0 },
  };
}

async function writeFile(rootDir: string, relPath: string, content: string): Promise<void> {
  const fullPath = path.join(rootDir, relPath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content);
}

describe('scanDatabaseSchema', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibgrate-db-schema-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('returns undefined when there are no prisma files', async () => {
    await writeFile(tempDir, 'src/index.ts', '// nothing here\n');
    const result = await scanDatabaseSchema(tempDir, [makeProject('app', '.')]);
    expect(result).toBeUndefined();
  });

  it('parses models with scalar, relation, list, and optional fields', async () => {
    await writeFile(
      tempDir,
      'prisma/schema.prisma',
      `
      datasource db {
        provider = "postgresql"
        url      = env("DATABASE_URL")
      }

      generator client {
        provider = "prisma-client-js"
      }

      model User {
        id    String  @id @default(uuid())
        email String  @unique
        name  String?
        posts Post[]
      }

      model Post {
        id       String @id @default(uuid())
        title    String
        author   User   @relation(fields: [authorId], references: [id])
        authorId String
      }
      `,
    );

    const result = await scanDatabaseSchema(tempDir, [makeProject('app', '.')]);
    expect(result).toBeDefined();
    expect(result!.providers).toEqual(['postgresql']);
    expect(result!.filesScanned).toEqual(['prisma/schema.prisma']);

    const models = result!.models;
    expect(models.map((m) => m.name)).toEqual(['Post', 'User']);

    const user = models.find((m) => m.name === 'User')!;
    const email = user.fields.find((f) => f.name === 'email')!;
    expect(email).toMatchObject({ type: 'String', isUnique: true, isId: false, isOptional: false, isList: false, isRelation: false });

    const id = user.fields.find((f) => f.name === 'id')!;
    expect(id).toMatchObject({ isId: true, isUnique: false, isRelation: false });

    const name = user.fields.find((f) => f.name === 'name')!;
    expect(name).toMatchObject({ isOptional: true, isRelation: false });

    const posts = user.fields.find((f) => f.name === 'posts')!;
    expect(posts).toMatchObject({ type: 'Post', isList: true, isRelation: true });

    const post = models.find((m) => m.name === 'Post')!;
    const author = post.fields.find((f) => f.name === 'author')!;
    expect(author).toMatchObject({ type: 'User', isRelation: true });
    const authorId = post.fields.find((f) => f.name === 'authorId')!;
    expect(authorId).toMatchObject({ type: 'String', isRelation: false });
  });

  it('parses enum blocks', async () => {
    await writeFile(
      tempDir,
      'schema.prisma',
      `
      enum Role {
        ADMIN
        USER
        GUEST
      }

      model User {
        id   String @id
        role Role
      }
      `,
    );

    const result = await scanDatabaseSchema(tempDir, [makeProject('app', '.')]);
    expect(result!.enums).toEqual([{ name: 'Role', values: ['ADMIN', 'GUEST', 'USER'] }]);
  });

  it('never captures the datasource url — no connection string in the result', async () => {
    const secretUrl = 'postgresql://vibgrate_user:sup3r-s3cr3t@db.internal.example.com:5432/prod';
    await writeFile(
      tempDir,
      'schema.prisma',
      `
      datasource db {
        provider = "postgresql"
        url      = "${secretUrl}"
      }

      model User {
        id String @id
      }
      `,
    );

    const result = await scanDatabaseSchema(tempDir, [makeProject('app', '.')]);
    expect(result).toBeDefined();
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(secretUrl);
    expect(serialized).not.toContain('sup3r-s3cr3t');
    expect(serialized).not.toContain('vibgrate_user');
    expect(result!.providers).toEqual(['postgresql']);
  });

  it('scans multiple .prisma files and attributes them to the owning project', async () => {
    await writeFile(
      tempDir,
      'packages/api/prisma/schema.prisma',
      `
      datasource db {
        provider = "mysql"
        url      = env("DATABASE_URL")
      }

      model Widget {
        id   Int    @id
        name String
      }
      `,
    );
    await writeFile(
      tempDir,
      'packages/worker/prisma/schema.prisma',
      `
      datasource db {
        provider = "sqlite"
        url      = env("WORKER_DATABASE_URL")
      }

      model Job {
        id     Int    @id
        status String
      }
      `,
    );

    const projects = [
      makeProject('api', 'packages/api'),
      makeProject('worker', 'packages/worker'),
    ];
    const result = await scanDatabaseSchema(tempDir, projects);

    expect(result).toBeDefined();
    expect(result!.providers).toEqual(['mysql', 'sqlite']);
    expect(result!.filesScanned).toEqual([
      'packages/api/prisma/schema.prisma',
      'packages/worker/prisma/schema.prisma',
    ]);
    expect(result!.models.map((m) => m.name)).toEqual(['Job', 'Widget']);

    expect(result!.projects).toEqual([
      {
        project: 'packages/api',
        filesScanned: ['packages/api/prisma/schema.prisma'],
        models: ['Widget'],
        enums: [],
      },
      {
        project: 'packages/worker',
        filesScanned: ['packages/worker/prisma/schema.prisma'],
        models: ['Job'],
        enums: [],
      },
    ]);
  });

  it('returns undefined gracefully for a project with no prisma files, even with unrelated source files present', async () => {
    await writeFile(tempDir, 'src/app.ts', 'export const x = 1;\n');
    await writeFile(tempDir, 'package.json', '{"name":"app"}\n');

    const result = await scanDatabaseSchema(tempDir, [makeProject('app', '.')]);
    expect(result).toBeUndefined();
  });

  // ── Raw SQL migrations ──

  describe('raw SQL migrations', () => {
    it('parses CREATE TABLE statements into tagged models', async () => {
      await writeFile(
        tempDir,
        'migrations/001_init.sql',
        `
        CREATE TABLE users (
          id INT PRIMARY KEY,
          email VARCHAR(255) NOT NULL UNIQUE,
          bio TEXT,
          org_id INT REFERENCES organizations(id)
        );
        `,
      );

      const result = await scanDatabaseSchema(tempDir, [makeProject('app', '.')]);
      expect(result).toBeDefined();
      expect(result!.filesScanned).toEqual(['migrations/001_init.sql']);

      const users = result!.models.find((m) => m.name === 'users')!;
      expect(users.source).toBe('sql-migration');
      expect(users.files).toEqual(['migrations/001_init.sql']);

      const id = users.fields.find((f) => f.name === 'id')!;
      expect(id).toMatchObject({ type: 'INT', isId: true, isOptional: false });

      const email = users.fields.find((f) => f.name === 'email')!;
      expect(email).toMatchObject({ type: 'VARCHAR(255)', isOptional: false, isUnique: true });

      const bio = users.fields.find((f) => f.name === 'bio')!;
      expect(bio).toMatchObject({ type: 'TEXT', isOptional: true });

      const orgId = users.fields.find((f) => f.name === 'org_id')!;
      expect(orgId).toMatchObject({ isRelation: true });
    });

    it('handles a DECIMAL(10,2)-style type without breaking on the nested comma', async () => {
      await writeFile(
        tempDir,
        'db/migrate/002_products.sql',
        `CREATE TABLE products (id INT PRIMARY KEY, price DECIMAL(10, 2) NOT NULL);`,
      );

      const result = await scanDatabaseSchema(tempDir, [makeProject('app', '.')]);
      const products = result!.models.find((m) => m.name === 'products')!;
      const price = products.fields.find((f) => f.name === 'price')!;
      expect(price.type).toBe('DECIMAL(10, 2)');
      expect(price.isOptional).toBe(false);
    });

    it('the first CREATE TABLE for a name wins; a later ALTER TABLE is not parsed', async () => {
      await writeFile(
        tempDir,
        'sql/schema.sql',
        `
        CREATE TABLE accounts (id INT PRIMARY KEY, name VARCHAR(100));
        ALTER TABLE accounts ADD COLUMN balance DECIMAL(12, 2);
        `,
      );

      const result = await scanDatabaseSchema(tempDir, [makeProject('app', '.')]);
      const accounts = result!.models.find((m) => m.name === 'accounts')!;
      expect(accounts.fields.map((f) => f.name).sort()).toEqual(['id', 'name']);
    });

    it('defense-in-depth: strips a credential-looking URL line before parsing, never in the result', async () => {
      const secretUrl = 'postgresql://vibgrate_user:sup3r-s3cr3t@db.internal.example.com:5432/prod';
      await writeFile(
        tempDir,
        'migrations/003_note.sql',
        `
        -- connection string left in a comment by mistake: ${secretUrl}
        CREATE TABLE widgets (
          id INT PRIMARY KEY,
          name VARCHAR(50) NOT NULL
        );
        `,
      );

      const result = await scanDatabaseSchema(tempDir, [makeProject('app', '.')]);
      expect(result).toBeDefined();
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(secretUrl);
      expect(serialized).not.toContain('sup3r-s3cr3t');
      expect(serialized).not.toContain('vibgrate_user');
      expect(result!.models.map((m) => m.name)).toEqual(['widgets']);
    });
  });

  // ── SQL Server Database Projects (.sqlproj) ──

  describe('.sqlproj (SQL Server Database Projects)', () => {
    it('parses .sql table scripts under a .sqlproj directory tree, tagged as sqlproj', async () => {
      await writeFile(tempDir, 'db/MyDatabase.sqlproj', `<Project Sdk="Microsoft.Build.Sql"><PropertyGroup><Name>MyDatabase</Name></PropertyGroup></Project>`);
      await writeFile(
        tempDir,
        'db/dbo/Tables/Customers.sql',
        `CREATE TABLE [dbo].[Customers] (
          [Id] INT NOT NULL PRIMARY KEY,
          [Name] NVARCHAR(200) NOT NULL
        );`,
      );

      const result = await scanDatabaseSchema(tempDir, [makeProject('app', '.')]);
      expect(result).toBeDefined();
      const customers = result!.models.find((m) => m.name === 'Customers')!;
      expect(customers.source).toBe('sqlproj');
      expect(customers.files).toEqual(['db/dbo/Tables/Customers.sql']);
      expect(customers.fields.map((f) => f.name).sort()).toEqual(['Id', 'Name']);

      // Not also picked up as a generic sql-migration model (no double-count).
      expect(result!.models.filter((m) => m.name === 'Customers')).toHaveLength(1);
    });
  });

  // ── Drizzle ORM ──

  describe('Drizzle ORM', () => {
    it('parses pgTable() calls into tagged models', async () => {
      await writeFile(
        tempDir,
        'src/schema.ts',
        `
        import { pgTable, text, integer } from 'drizzle-orm/pg-core';

        export const users = pgTable('users', {
          id: integer('id').primaryKey(),
          email: text('email').notNull().unique(),
          orgId: integer('org_id').references(() => organizations.id),
        });
        `,
      );

      const result = await scanDatabaseSchema(tempDir, [makeProject('app', '.')]);
      expect(result).toBeDefined();
      expect(result!.filesScanned).toEqual(['src/schema.ts']);

      const users = result!.models.find((m) => m.name === 'users')!;
      expect(users.source).toBe('drizzle');
      expect(users.files).toEqual(['src/schema.ts']);

      const id = users.fields.find((f) => f.name === 'id')!;
      expect(id).toMatchObject({ type: 'integer', isId: true });

      const email = users.fields.find((f) => f.name === 'email')!;
      expect(email).toMatchObject({ type: 'text', isOptional: false, isUnique: true });

      const orgId = users.fields.find((f) => f.name === 'orgId')!;
      expect(orgId).toMatchObject({ type: 'integer', isRelation: true });
    });

    it('ignores a pgTable-like call not imported from drizzle-orm', async () => {
      await writeFile(
        tempDir,
        'src/not-drizzle.ts',
        `
        function pgTable(name: string, cols: unknown) { return { name, cols }; }
        export const fake = pgTable('fake', { id: 'not-a-builder-call' });
        `,
      );

      const result = await scanDatabaseSchema(tempDir, [makeProject('app', '.')]);
      expect(result).toBeUndefined();
    });
  });

  // ── TypeORM ──

  describe('TypeORM', () => {
    it('parses @Entity() classes into tagged models', async () => {
      await writeFile(
        tempDir,
        'src/entities/user.entity.ts',
        `
        import { Entity, PrimaryGeneratedColumn, Column, OneToMany } from 'typeorm';

        @Entity('users')
        export class User {
          @PrimaryGeneratedColumn()
          id: number;

          @Column()
          email: string;

          @Column()
          bio?: string;

          @OneToMany(() => Post, (post) => post.author)
          posts: Post[];
        }
        `,
      );

      const result = await scanDatabaseSchema(tempDir, [makeProject('app', '.')]);
      expect(result).toBeDefined();
      const users = result!.models.find((m) => m.name === 'users')!;
      expect(users.source).toBe('typeorm');
      expect(users.files).toEqual(['src/entities/user.entity.ts']);

      const id = users.fields.find((f) => f.name === 'id')!;
      expect(id).toMatchObject({ type: 'number', isId: true, isRelation: false });

      const bio = users.fields.find((f) => f.name === 'bio')!;
      expect(bio).toMatchObject({ isOptional: true });

      const posts = users.fields.find((f) => f.name === 'posts')!;
      expect(posts).toMatchObject({ isRelation: true, isList: true });
    });

    it('falls back to the class name when @Entity() has no string/name arg', async () => {
      await writeFile(
        tempDir,
        'src/entities/order.entity.ts',
        `
        import { Entity, PrimaryColumn } from 'typeorm';

        @Entity()
        export class Order {
          @PrimaryColumn()
          id: string;
        }
        `,
      );

      const result = await scanDatabaseSchema(tempDir, [makeProject('app', '.')]);
      expect(result!.models.map((m) => m.name)).toEqual(['Order']);
    });
  });

  // ── Cross-source merging ──

  describe('multiple sources in one repo', () => {
    it('surfaces models from every source present, each correctly tagged, without cross-source merging', async () => {
      await writeFile(
        tempDir,
        'prisma/schema.prisma',
        `
        model User {
          id    String @id
          email String @unique
        }
        `,
      );
      await writeFile(
        tempDir,
        'migrations/001_users.sql',
        `CREATE TABLE users (id INT PRIMARY KEY, email VARCHAR(255));`,
      );

      const result = await scanDatabaseSchema(tempDir, [makeProject('app', '.')]);
      expect(result).toBeDefined();

      const prismaUser = result!.models.find((m) => m.name === 'User' && m.source === 'prisma');
      const sqlUsers = result!.models.find((m) => m.name === 'users' && m.source === 'sql-migration');
      expect(prismaUser).toBeDefined();
      expect(sqlUsers).toBeDefined();
      // Distinct entries — never silently merged just because the names are similar.
      expect(result!.models.filter((m) => m.name === 'User' || m.name === 'users')).toHaveLength(2);

      const sources = new Set(result!.models.map((m) => m.source));
      expect(sources).toEqual(new Set(['prisma', 'sql-migration']));
    });
  });
});
