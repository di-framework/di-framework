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

