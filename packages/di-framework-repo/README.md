# @di-framework/repo

A coherent abstraction of repositories and storage adapters for TypeScript, with optional integration for `di-framework-core`.

## Features

- **Storage Agnostic**: Decouples your business logic from the underlying storage technology (SQL, NoSQL, In-Memory, etc.).
- **Standardized Patterns**: Provides `BaseRepository`, `EntityRepository`, and `SoftDeleteRepository` to handle common data access patterns.
- **Built-in Pagination**: Standardized `Page` and `PaginatedResult` types with built-in support in adapters and repositories.
- **In-Memory Implementation**: Includes a fully functional `InMemoryRepository` for prototyping and testing.
- **DI Integration**: Seamlessly integrates with `di-framework-core` via the `@Repository` decorator.
- **Models**: Optional Spring/JPA-style `@Model`, `@Id`, and `@GeneratedValue` for multi-context identity metadata.

## Installation

```bash
bun add @di-framework/repo
```

Required for DI integration: If you want to use the `@Repository` decorator for dependency injection, install the DI framework peer dependency.

```bash
bun add @di-framework/core
```

Important: Always import from the scoped package name `@di-framework/core/*`.

Mixing different import IDs (e.g., `di-framework/*` or relative paths to sources) can load a second copy of the library and create a second global container instance.

Correct:

```ts
import { useContainer } from '@di-framework/core/container';
import { Container, Component } from '@di-framework/core/decorators';
```

Avoid:

```ts
import { useContainer } from 'di-framework/container'; // Wrong: unscoped id
import { Container } from '../../di-framework/decorators'; // Wrong: relative id
```

## Basic Usage

### 1. Define your Model

Use `@Model` on a class. Mark identity fields with `@Id` and optional `@GeneratedValue` (stacked like Spring/JPA). The class **is** the TypeScript type — no separate interface is required. Storage can still use plain objects assignable to that shape.

```typescript
import {
  GeneratedValue,
  GenerationType,
  Id,
  IdKind,
  Model,
} from '@di-framework/repo';

@Model()
class User {
  @Id()
  @GeneratedValue({ strategy: GenerationType.Identity })
  id!: number;

  @Id({ kind: IdKind.Public })
  @GeneratedValue({ strategy: GenerationType.UUID }) // UUIDv7 in this framework
  publicId!: string;

  name!: string;
  email!: string;
}
```

#### Identity contexts (`IdKind`)

A model may have several identity fields — each identifies the record in a different context:

| Kind | Typical field | Role |
| --- | --- | --- |
| `Primary` (default) | `id` | Database / repository primary key. Several `Primary` fields = composite PK. |
| `Public` | `publicId` | Safe id for URLs / APIs (often UUIDv7). |
| `External` | `stripeCustomerId` | Id assigned by another system. |
| `Legacy` | `legacyId` | Retained during migration. |
| `Tenant` | `tenantId` | Owning org / customer (may also be part of a composite PK). |
| `Version` | `versionId` | Particular revision. |

`@Id` is for identities **of this model**. Foreign keys to other models are not `IdKind`s (relations stay separate).

#### Generation (`GenerationType`)

Aligned with Jakarta Persistence `GenerationType`: `Auto`, `Identity`, `Sequence`, `Table`, `UUID`.

- `@GeneratedValue` must be stacked with `@Id` on the same property.
- Default strategy when `@GeneratedValue()` is used without options is `Auto`.
- **`GenerationType.UUID` means UUIDv7** (RFC 9562 time-ordered), not random v4 — intentional default for index-friendly keys.

Metadata is optional for repositories today — use `getModelMetadata` / `getIdentities` / `getPrimaryId` / `isModel` when adapters need it. Repositories still take an explicit id type parameter (`InMemoryRepository<User, number>`).

Plain interfaces still work if you prefer them:

```typescript
interface User {
  id: number;
  name: string;
  email: string;
}
```

### 2. Implement a Repository

You can extend `InMemoryRepository` for quick prototyping:

```typescript
import { InMemoryRepository } from '@di-framework/repo';

class UserRepository extends InMemoryRepository<User, number> {
  async findByEmail(email: string): Promise<User | null> {
    const all = await this.findAll();
    return all.find((u) => u.email === email) || null;
  }
}
```

### 3. Use with di-framework

Use the `@Repository` decorator to automatically register your repository with the `di-framework-core` container.

```typescript
import {
  GeneratedValue,
  GenerationType,
  Id,
  Model,
  Repository,
  InMemoryRepository,
} from '@di-framework/repo';

@Model()
class User {
  @Id()
  @GeneratedValue({ strategy: GenerationType.Identity })
  id!: number;
  name!: string;
  email!: string;
}

@Repository()
class UserRepository extends InMemoryRepository<User, number> {
  // ...
}

// In another service
@Container()
class UserService {
  constructor(@Component(UserRepository) private users: UserRepository) {}

  async listUsers() {
    return this.users.findAll();
  }
}
```

## Storage Adapters

The `StorageAdapter` interface allows you to implement custom backends.

```typescript
import { StorageAdapter, BaseRepository } from '@di-framework/repo';

class MyCustomAdapter<E, ID> implements StorageAdapter<E, ID> {
  // Implement findById, save, delete, findPaginated, etc.
}

class MyRepository extends BaseRepository<User, number> {
  constructor(adapter: MyCustomAdapter<User, number>) {
    super(adapter);
  }
}
```

## API Overview

### Repository Classes

- `BaseRepository<E, ID>`: The foundational repository class.
- `EntityRepository<E, ID>`: Standard entity-aware repository.
- `SoftDeleteRepository<E, ID>`: Repository with soft-delete capabilities.
- `InMemoryRepository<E, ID>`: Ready-to-use in-memory implementation.

### Decorators

- `@Model()`: Marks a class as a domain data model.
- `@Id(options?)`: Marks an identity field (`kind?: IdKind`, default `Primary`).
- `@GeneratedValue(options?)`: Stacked with `@Id`; `strategy?: GenerationType` (default `Auto`). UUID ⇒ UUIDv7.
- `@Repository(options)`: Registers the class as a singleton in `di-framework-core`.

### Identity helpers

- `IdKind` / `GenerationType`: const objects + string unions.
- `getModelMetadata` / `getIdentities` / `getPrimaryId` / `isModel`.

### Types

- `StorageAdapter<E, ID>`: Interface for storage implementations.
- `Page<T>` / `PaginatedResult<T>`: Standardized pagination metadata.
- `EntityId`: Type alias for `string | number`.
# Durable SQL adapters

`BunSqliteAdapter` and `D1Adapter` implement the complete `StorageAdapter` contract over an existing SQLite-compatible table. The adapter intentionally does not run migrations: create the table in your application and provide an explicit `table` (plus `idColumn`, `entityToRow`, and `rowToEntity` when needed).

```ts
const users = new BunSqliteAdapter(db, { table: 'users', idColumn: 'id' });
await users.findPaginated({ page: 1, size: 20, sort: 'name:asc', filter: { active: true } });
```

Cloudflare D1 uses the same options and binding API. D1 transactions are scoped to the callback and D1's platform batch/statement limits apply; schema changes and migrations remain out of band. Bun adapters close their database from `dispose()`; D1 disposal is a no-op.

## Conditional Writes & Atomic Operations

Adapters may optionally implement `ConditionalStorageAdapter<E, ID>` to support atomic conditional write capabilities:

- `saveIfAbsent(entity: E): Promise<boolean>`: Inserts `entity` only if no record with its ID currently exists. Returns `true` if inserted, or `false` if a record with the same ID already exists. Built-in SQL adapters use `INSERT INTO ... ON CONFLICT (...) DO NOTHING` and check for positive affected rows.
- `compareAndSwap(id: ID, mutate: (current: E | null) => E | null): Promise<boolean>`: Executes a synchronous, side-effect-free `mutate` function atomically against the current state at `id`. If `mutate` returns `null` (condition failed or abort requested), the operation aborts without writing and returns `false`. If `mutate` returns a non-null entity, it updates the record and returns `true`.

Use the exported type guard `supportsConditionalWrite(adapter)` to detect capability support at runtime:

```ts
import { supportsConditionalWrite } from '@di-framework/repo';

if (supportsConditionalWrite(adapter)) {
  const inserted = await adapter.saveIfAbsent(entity);
  const swapped = await adapter.compareAndSwap(id, (current) => {
    if (!current || current.version !== expectedVersion) return null;
    return { ...current, version: current.version + 1 };
  });
}
```

Built-in adapters (`InMemoryRepository`, `SqlStorageAdapter`, `BunSqliteAdapter`, `D1Adapter`) implement `ConditionalStorageAdapter`. Custom `StorageAdapter` implementations do not require source changes unless conditional write capability is desired.

## Blob Storage Primitives & S3 Adapters

For binary assets, large files, media uploads, and documents, `@di-framework/repo` provides first-class Blob storage primitives:

- `BaseBlobRepository`: Abstract base class for type-safe binary asset repositories.
- `BlobStorageAdapter`: Contract for blob storage engines.
- `InMemoryBlobStorageAdapter`: In-memory implementation with full pagination and delimiter support for testing.
- `S3BlobStorageAdapter`: Production adapter supporting AWS S3, Cloudflare R2, MinIO, Wasabi, and S3-compatible APIs, including automatic multipart uploads for large files and presigned URLs.

### Usage Example

```typescript
import {
  BaseBlobRepository,
  InMemoryBlobStorageAdapter,
  S3BlobStorageAdapter,
} from '@di-framework/repo';

class MediaRepository extends BaseBlobRepository {
  constructor() {
    super(
      new S3BlobStorageAdapter({
        bucket: 'my-app-media',
        region: 'us-east-1',
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      }),
    );
  }
}

const mediaRepo = new MediaRepository();

// Put file (supports string, Buffer, Uint8Array, ReadableStream, Blob)
await mediaRepo.put('uploads/doc.pdf', fileStream, {
  contentType: 'application/pdf',
  customMetadata: { userId: '123' },
});

// Read file
const blob = await mediaRepo.get('uploads/doc.pdf');
if (blob) {
  console.log(blob.metadata.size);
  const text = await blob.text();
}

// Generate presigned URL
const signedUrl = await mediaRepo.getSignedUrl('uploads/doc.pdf', {
  operation: 'get',
  expiresInSeconds: 3600,
});

// List with pagination and prefix
const results = await mediaRepo.list({ prefix: 'uploads/', delimiter: '/' });
```


## Database Migrations

`@di-framework/repo` provides database schema migrations supporting both decorator-based definitions and SQL/manifest-based discovery:

- **`@Migration({ version, description, binding })`**: Class decorator defining migrations with dependency-injected execution context.
- **Manifest and SQL Discovery**: Discovers `.sql` migration files with standard version headers (`-- migration:version`, `-- migration:description`, etc.) or manifest files (`migrations.json`).
- **Shared Runner (`MigrationRunner`)**:
  - **DB-backed locking**: Serializes concurrent migration attempts using a lock table (`_migrations_lock`).
  - **History tracking**: Records applied versions, checksums, timestamps, and execution times in `_migrations`.
  - **Version ordering**: Applies pending migrations sequentially in ascending version order.
  - **Integrity validation**: Validates applied migration checksums against current definitions and rejects out-of-order pending migrations.
  - **Dev auto-apply**: Automatically applies pending migrations in development/test environments.

### Example: Decorator Migration

```ts
import { Migration, type MigrationExecutionContext } from '@di-framework/repo';

@Migration({
  version: 1,
  description: 'create users table',
  binding: 'default',
})
export class CreateUsersTable {
  async up(ctx: MigrationExecutionContext): Promise<void> {
    await ctx.sql('CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)');
  }

  async down(ctx: MigrationExecutionContext): Promise<void> {
    await ctx.sql('DROP TABLE users');
  }
}
```

### CLI Commands

```bash
# Check status of applied and pending migrations
di-framework migrations status --db ./dev.db --dir ./migrations

# Execute pending migrations
di-framework migrations execute --db ./dev.db --dir ./migrations

# Dry run / preview plan
di-framework migrations execute --db ./dev.db --dir ./migrations --dry-run

# Output stable JSON envelope
di-framework migrations status --db ./dev.db --json
```

## wasmCloud Postgres values

Guests that call the `wasmcloud:postgres` binding pass parameters as tagged `pg-value` variants. The host binds in binary, so a text payload in a `uuid` or `boolean` column is rejected. Import the codec from `@di-framework/repo/postgres`. The same functions are on the portable wasmCloud build (`import … from '@di-framework/repo'` when the `wasmcloud` export condition is set).

```ts
import { float8, int8, pgValue, readRows, text } from '@di-framework/repo/postgres';

const rows = await readRows(
  await query('select id from users where id = $1', [pgValue(userId)]),
);
await query('insert into events (id, score, label) values ($1, $2, $3)', [
  int8(id),
  float8(score),
  text(label),
]);
```

`pgValue` infers a default tag from the JavaScript value: `null`, `text`, `uuid` (UUID-shaped strings), `bool`, `int4`, `int8` (`bigint`, or a safe integer outside the int4 range), `numeric` (other finite numbers), `timestamp-tz`, `bytea`, and `jsonb`. That default is only a guess. The host binds in binary, so a small integer in an `int8` column, a float in a `float8` column, or a UUID-shaped string in a `text` column is rejected. Pass the column tag (`pgValue(value, 'int8')`) or use `text`, `uuid`, `int8`, or `float8`. `int8` keeps a `bigint` so values above 2^53 are not rounded. `pgScalar` turns one result cell into a JSON value; an `int8` that is not a safe integer becomes a decimal string. `readRows` reads the column list and row stream. `postgresError` and `assertBatch` surface an `err` variant. `isUniqueViolation` detects SQLSTATE `23505` at the start of a `PostgreSQL` error, or the words `duplicate key`.

Adapt the binding to `SqlDatabase` with `createSqlDatabase` in the guest. Do not point `MigrationRunner` at this binding. Postgres schema history stays a guest concern; the runner's placeholders and transaction handle are SQLite.

## Embedded PostgreSQL (PGlite) in a Wasm component

`createWasmPgliteDatabase` adapts the `di-framework:pglite/database@0.2.0` WIT import to `SqlDatabase`. The provider component bundles PostgreSQL 17 and stores the cluster under a directory in a writable WASI preopen; compose your component with it (see `platform/pglite-component` in [di-framework/platform](https://github.com/di-framework/platform)). The function is on the package entry and on the portable wasmCloud build.

```ts
import { createWasmPgliteDatabase, type SqlDatabase } from '@di-framework/repo';

// The database root is yours to choose. An empty path selects /data/pglite.
const db: SqlDatabase = await createWasmPgliteDatabase('/data/identity');

await db.exec('CREATE TABLE IF NOT EXISTS users (id uuid PRIMARY KEY, email text UNIQUE, meta jsonb)');
await db.transaction(async (tx) => {
  await tx.run('INSERT INTO users (id, email, meta) VALUES (?, ?, ?)', [id, email, { plan: 'free' }]);
});
const user = await db.first<{ email: string; meta: { plan: string } }>(
  'SELECT email, meta FROM users WHERE id = ?',
  [id],
);
```

The provider allows one open connection per component instance. Keep one handle and share it: every call goes through one async mutex.

- **Transactions.** `transaction(fn)` runs the provider's `begin` and `commit`, and `rollback` when `fn` throws. Statements issued from inside `fn`, through the callback view or the outer handle, join the transaction; other tasks wait for it. Inside `fn`, prefer the callback view: while the transaction is open it joins from any async context, including a worker loop or `AsyncResource` created earlier, and Wasm-guest code that the `node:async_hooks` shim does not instrument (native async generators). The outer handle joins only from `fn`'s own async context. From any other context it waits for the mutex, so awaiting it from `fn` deadlocks. A nested `transaction()` opens a savepoint. When it throws, only its own work rolls back, and the outer transaction can continue. Its work commits only with the outer transaction. Sibling savepoints started concurrently run one at a time. A plain statement issued through a view while a sibling savepoint is open joins that savepoint and rolls back with it: in `Promise.all([tx.transaction(failing), (async () => { await work(); await tx.run(...); })()])`, a `run` issued while the savepoint is open lands inside it, so await the savepoint first when the statement must survive it. Joining lasts only while the transaction is open: a timer scheduled inside `fn`, or a callback view kept after it returns, waits for the mutex like any other caller and never runs inside another task's transaction.
- **Placeholders.** `?` placeholders become `$1`, `$2`, ... in order. The rewrite skips `'...'` and `E'...'` strings, `"..."` identifiers, `$tag$...$tag$` bodies, `--` and `/* */` comments, and the jsonb operators `?|` and `?&`. Because of that, `?||` reads as `?|` followed by `|`: put a space in the concatenation (`? || 'x'`). The bare jsonb `?` operator looks like a placeholder: use `jsonb_exists(col, ?)` in a statement with parameters. A statement run without parameters is not rewritten. You can write `$n` yourself, but do not mix `$n` with `?` in one statement.
- **Parameters.** `string` is sent as text, and PostgreSQL infers its type from context, so a UUID or timestamp string works against `uuid` and `timestamptz` columns. A safe integer is `int8`, another number is `float8`, a `boolean` is `bool`, and `Uint8Array`, `ArrayBuffer` and typed arrays are `bytea`. A `Date` is sent as an RFC 3339 timestamp. Plain objects and arrays are sent as JSON, so a JavaScript array is not a PostgreSQL array: pass a literal such as `'{a,b}'`. A `bigint` outside the safe integer range is sent as decimal text, so it is not rounded.
- **Results.** Values match the `wasmcloud:postgres` codec above, so repositories behave the same on both backends. `json` and `jsonb` are parsed. `timestamptz` is an ISO string with milliseconds (`2024-01-15T10:30:00.123Z`, microseconds truncated); `infinity` and BC dates are returned as PostgreSQL prints them. An `int8` outside the safe integer range is a decimal string, but only when the binding lifts WIT `s64` as a `bigint`; a binding that lifts it as a JavaScript number (componentize-qjs lowers `s64` from numbers) has already lost the precision, so cast large `int8` columns to `text` in the query (`id::text`) when exact values matter. `bool` is a boolean, `bytea` is a `Uint8Array`, and `timestamp` without zone, `date`, `uuid`, `numeric` and arrays are strings.
- **Errors.** Failures throw `WasmPgliteError` with the WIT `tag`. A PostgreSQL error keeps its SQLSTATE in `error.code` (`'23505'` for a unique violation), and the message starts with `PostgreSQL <code>`, so `isUniqueViolation` works too.

Pass `module` or `loadModule` to supply the interface yourself (for tests), and `database` or `statementTimeoutMs` to forward `open-options`. `createSqlDatabaseFromWasmPgliteConnection` wraps a connection you have already opened. `toPgPlaceholders` is exported on its own.
