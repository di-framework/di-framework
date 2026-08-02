# Repositories (df-repo)

`@di-framework/di-framework-repo` provides a coherent abstraction of repositories and storage adapters, allowing you to decouple your business logic from the underlying storage technology. It integrates seamlessly with `@di-framework/di-framework`.

## Key Concepts

### Storage Adapter

A `StorageAdapter` is a minimal protocol that every storage backend must implement. It keeps the repository layer agnostic to whether you are using SQL, NoSQL, In-Memory, or an external API.

```typescript
export interface StorageAdapter<E, ID = string | number> {
  findById(id: ID): Promise<E | null>;
  findAll(): Promise<E[]>;
  save(entity: E): Promise<E>;
  delete(id: ID): Promise<boolean>;
  findPaginated(params: PaginationParams): Promise<PaginatedResult<E>>;
  // ...
}
```

### Repository

The `Repository` layer uses a `StorageAdapter` to perform data operations. It can add business logic, caching, validation, or event dispatching.

- `BaseRepository<E, ID>`: The foundational repository class.
- `EntityRepository<E, ID>`: A standard entity-aware repository.
- `SoftDeleteRepository<E, ID>`: Adds `softDelete`, `restore`, and filtering for active/deleted records.

## Installation

```bash
bun add @di-framework/di-framework-repo
```

## Important: Scoped imports

Always import from the scoped package `@di-framework/di-framework/*` to ensure a single global container instance. Mixing different import IDs (e.g., `di-framework/*` or relative paths to sources) can load a second copy of the library and create a second global container instance.

Correct:

```typescript
import { useContainer } from '@di-framework/di-framework/container';
import { Container, Component } from '@di-framework/di-framework/decorators';
```

Avoid:

```typescript
import { useContainer } from 'di-framework/container'; // Wrong: unscoped id
import { Container } from '../../di-framework/decorators'; // Wrong: relative id
```

## Usage with @di-framework/di-framework

The `@Repository` decorator automatically registers your repository with the `@di-framework/di-framework` container.

```typescript
import { Repository, InMemoryRepository } from '@di-framework/di-framework-repo';

interface User {
  id: number;
  name: string;
}

@Repository()
class UserRepository extends InMemoryRepository<User, number> {}
```

### Injecting Repositories

Once registered, you can inject your repository into any other container-managed class:

```typescript
import { Container, Component } from '@di-framework/di-framework/decorators';

@Container()
class UserService {
  constructor(@Component(UserRepository) private userRepository: UserRepository) {}

  async getUser(id: number) {
    return this.userRepository.findById(id);
  }
}
```

## Built-in In-Memory Repository

For prototyping, testing, or simple local state, use `InMemoryRepository`:

```typescript
const repo = new InMemoryRepository<MyEntity, string>();
await repo.save({ id: '1', name: 'Test' });
const items = await repo.findPaginated({ page: 1, size: 10 });
```

## Custom Adapters

You can implement your own adapter to connect to any data source:

```typescript
import { StorageAdapter, EntityRepository } from '@di-framework/di-framework-repo';

class PostgresAdapter<E, ID> implements StorageAdapter<E, ID> {
  // Implementation details...
}

@Repository()
class ProductRepository extends EntityRepository<Product, string> {
  constructor() {
    super(new PostgresAdapter<Product, string>());
  }
}
```
