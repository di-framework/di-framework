# Quick Start

This guide will walk you through the basic concepts of the DI framework with simple examples.

## 1. Basic Service

The simplest way to use the framework is to mark a class with the `@Container()` decorator:

```typescript
import { Container } from '@di-framework/di-framework/decorators';

@Container()
export class DatabaseService {
  connect(): void {
    console.log('Connected to database');
  }

  query(sql: string) {
    console.log('Executing query:', sql);
    return { rows: [] };
  }
}
```

The `@Container()` decorator automatically registers the service with the DI container.

## 2. Service with Dependencies

You can inject dependencies into your services using the `@Component()` decorator:

### Property Injection

```typescript
import { Container, Component } from '@di-framework/di-framework/decorators';
import { DatabaseService } from './DatabaseService';

@Container()
export class UserService {
  @Component(DatabaseService)
  private db!: DatabaseService;

  constructor() {}

  getUser(id: string) {
    return this.db.query(`SELECT * FROM users WHERE id = '${id}'`);
  }
}
```

### Constructor Injection

```typescript
@Container()
export class UserService {
  constructor(@Component(DatabaseService) private db: DatabaseService) {}

  getUser(id: string) {
    return this.db.query(`SELECT * FROM users WHERE id = '${id}'`);
  }
}
```

> **Note:** Property injection works seamlessly with SWC and TypeScript's native decorator support.

## 3. Resolving Services

To use your services, resolve them from the container:

```typescript
import { useContainer } from '@di-framework/di-framework/container';
import { UserService } from './UserService';

const container = useContainer();
const userService = container.resolve<UserService>(UserService);

// All dependencies are automatically injected!
const user = userService.getUser('123');
```

## 4. Multiple Dependencies

You can inject multiple dependencies into a single service:

```typescript
@Container()
export class ApplicationContext {
  constructor(
    @Component(DatabaseService) private db: DatabaseService,
    @Component(LoggerService) private logger: LoggerService,
    @Component(AuthService) private auth: AuthService,
  ) {}

  async initialize() {
    this.logger.log('Initializing application...');
    await this.db.connect();
    this.auth.setup();
  }
}
```

## 5. How It Works

When you call `container.resolve(ServiceClass)`:

1. The container creates a new instance (or returns existing singleton)
2. It examines the constructor parameters and their types
3. It recursively resolves each dependency
4. Dependencies are injected into the constructor or properties
5. The configured instance is returned

By default, all services are **singletons** - the same instance is reused across your application.

## Complete Example

Here's a complete example showing how everything works together:

```typescript
// DatabaseService.ts
import { Container } from '@di-framework/di-framework/decorators';

@Container()
export class DatabaseService {
  connect() {
    console.log('Database connected');
  }

  query(sql: string) {
    return { rows: [] };
  }
}

// UserService.ts
import { Container, Component } from '@di-framework/di-framework/decorators';
import { DatabaseService } from './DatabaseService';

@Container()
export class UserService {
  @Component(DatabaseService)
  private db!: DatabaseService;

  getUser(id: string) {
    return this.db.query(`SELECT * FROM users WHERE id = '${id}'`);
  }
}

// main.ts
import { useContainer } from '@di-framework/di-framework/container';
import { UserService } from './UserService';

const container = useContainer();
const userService = container.resolve(UserService);
const user = userService.getUser('123');
console.log(user);
```

## Next Steps

- [API Reference](api-reference.md) - Learn about all available APIs and options
- [Advanced Usage](advanced-usage.md) - Explore advanced patterns like transient services and factory functions
- [Best Practices](best-practices.md) - Learn recommended patterns and approaches
