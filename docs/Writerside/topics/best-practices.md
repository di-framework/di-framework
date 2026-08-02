# Best Practices

Recommended patterns and approaches for using the DI framework effectively.

## 1. Mark All Services with @Container()

Make dependency management explicit by decorating all services:

```typescript
// Good
@Container()
export class UserService {
  // Implementation
}

// Avoid - Plain class without decoration
export class UserService {
  // Implementation
}
```

**Why:** The decorator makes it clear that a class is part of your DI system and automatically handles registration.

## 2. Use Constructor Injection for Mandatory Dependencies

Constructor injection makes dependencies explicit and ensures they're available before the service is used:

```typescript
// Good - Constructor injection
@Container()
export class UserService {
  constructor(
    @Component(DatabaseService) private db: DatabaseService,
    @Component(LoggerService) private logger: LoggerService,
  ) {}
}

// Acceptable - Property injection (for optional dependencies)
@Container()
export class UserService {
  @Component(DatabaseService)
  private db!: DatabaseService;
}
```

**Why:** Constructor injection makes dependencies obvious and prevents services from being in an incomplete state.

## 3. Keep Property Injection Minimal

Use property injection sparingly, primarily for optional dependencies:

```typescript
// Good - Limited property injection
@Container()
export class UserService {
  constructor(@Component(DatabaseService) private db: DatabaseService) {}

  @Component(CacheService)
  private cache?: CacheService; // Optional dependency

  getUser(id: string) {
    if (this.cache) {
      const cached = this.cache.get(id);
      if (cached) return cached;
    }
    return this.db.query(`SELECT * FROM users WHERE id = '${id}'`);
  }
}
```

**Why:** Property injection can make dependencies less obvious and may lead to incomplete service initialization.

## 4. No Need to Import reflect-metadata

This framework uses a lightweight metadata store - you don't need reflect-metadata:

```typescript
// Good - No reflect-metadata import needed
import { Container, Component } from '@di-framework/di-framework/decorators';

@Container()
export class MyService {
  constructor(@Component(DatabaseService) private db: DatabaseService) {}
}

// Avoid - Unnecessary import
import 'reflect-metadata';
```

**Why:** The framework is designed to work without reflect-metadata, keeping your bundle size small.

## 5. Separate Service Interfaces from Implementations

Define interfaces for easier testing and flexibility:

```typescript
// Good - Interface-based design
export interface ILogger {
  log(message: string): void;
  error(error: Error): void;
}

@Container()
export class ConsoleLogger implements ILogger {
  log(message: string) {
    console.log(message);
  }

  error(error: Error) {
    console.error(error);
  }
}

@Container()
export class UserService {
  constructor(@Component(ConsoleLogger) private logger: ILogger) {}
}
```

**Why:** Interfaces make it easy to swap implementations for testing or different environments.

## 6. Use Singletons for Stateless Services

Most services should be singletons (the default):

```typescript
// Good - Singleton (default)
@Container()
export class DatabaseService {
  // Stateless operations
  query(sql: string) {
    return this.connection.query(sql);
  }
}

// Good - Transient for stateful services
@Container({ singleton: false })
export class RequestContext {
  requestId = Math.random().toString();
  userId?: string;
}
```

**Why:** Singletons improve performance and reduce memory usage. Use transient only when you need isolated state.

## 7. Use Transient for Stateful Services

Services with mutable state that shouldn't be shared should be transient:

```typescript
// Good - Transient for request-scoped state
@Container({ singleton: false })
export class RequestContext {
  private data = new Map<string, any>();

  set(key: string, value: any) {
    this.data.set(key, value);
  }

  get(key: string) {
    return this.data.get(key);
  }
}
```

**Why:** Prevents state leakage between requests or operations.

## 8. Initialize Services at Application Startup

Validate your DI configuration early:

```typescript
// Good - Startup validation
@Container()
export class Application {
  constructor(
    @Component(DatabaseService) private db: DatabaseService,
    @Component(AuthService) private auth: AuthService,
    @Component(CacheService) private cache: CacheService,
  ) {}

  async initialize() {
    // Validate all services are available
    await this.db.connect();
    await this.cache.connect();
    this.auth.setup();
    console.log('Application initialized successfully');
  }
}

// In your entry point
const container = useContainer();
const app = container.resolve(Application);
await app.initialize();
```

**Why:** Catches configuration errors early instead of at runtime when a service is first needed.

## 9. Use Factory Functions for Configuration

Register configuration as factory services:

```typescript
// Good - Configuration as factory
container.registerFactory(
  'config',
  () => ({
    database: {
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '5432'),
    },
    api: {
      key: process.env.API_KEY,
    },
  }),
  { singleton: true },
);

@Container()
export class DatabaseService {
  constructor(@Component('config') private config: any) {
    console.log('Connecting to:', this.config.database.host);
  }
}
```

**Why:** Centralizes configuration and makes it easy to inject environment-specific settings.

## 10. Organize Services by Feature

Structure your services by feature or domain:

```
src/
  features/
    user/
      UserService.ts
      UserRepository.ts
    auth/
      AuthService.ts
      TokenService.ts
    billing/
      BillingService.ts
      PaymentService.ts
```

**Why:** Improves code organization and makes it easier to understand dependencies.

## 11. Keep Services Focused (Single Responsibility)

Each service should have a single, well-defined purpose:

```typescript
// Good - Focused services
@Container()
export class UserRepository {
  // Only handles data access
  findById(id: string) {}
  save(user: User) {}
}

@Container()
export class UserValidator {
  // Only handles validation
  validate(user: User) {}
}

@Container()
export class UserService {
  constructor(
    @Component(UserRepository) private repo: UserRepository,
    @Component(UserValidator) private validator: UserValidator,
  ) {}

  // Orchestrates user operations
  async createUser(data: any) {
    this.validator.validate(data);
    return this.repo.save(data);
  }
}
```

**Why:** Smaller, focused services are easier to test, maintain, and reuse.

## 12. Document Dependencies

Add comments to clarify why dependencies are needed:

```typescript
@Container()
export class OrderService {
  constructor(
    @Component(DatabaseService) private db: DatabaseService, // Data persistence
    @Component(PaymentService) private payment: PaymentService, // Payment processing
    @Component(EmailService) private email: EmailService, // Order confirmations
    @Component(LoggerService) private logger: LoggerService, // Audit trail
  ) {}
}
```

**Why:** Makes code more maintainable and helps new developers understand dependencies.

## 13. Avoid Circular Dependencies

Design services to have clear dependency hierarchies:

```typescript
// Bad - Circular dependency
@Container()
class ServiceA {
  constructor(@Component(ServiceB) private b: ServiceB) {}
}

@Container()
class ServiceB {
  constructor(@Component(ServiceA) private a: ServiceA) {}
}

// Good - Clear hierarchy
@Container()
class SharedService {}

@Container()
class ServiceA {
  constructor(@Component(SharedService) private shared: SharedService) {}
}

@Container()
class ServiceB {
  constructor(@Component(SharedService) private shared: SharedService) {}
}
```

**Why:** Circular dependencies indicate design problems and are harder to test and maintain.

## 14. Test with Isolated Containers

Use separate containers for testing:

```typescript
// Good - Test isolation
import { Container as DIContainer } from '@di-framework/di-framework/container';

describe('UserService', () => {
  let testContainer: DIContainer;

  beforeEach(() => {
    testContainer = new DIContainer();
    testContainer.register(MockDatabaseService);
    testContainer.register(UserService);
  });

  it('should create user', () => {
    const service = testContainer.resolve(UserService);
    // Test implementation
  });
});
```

**Why:** Isolated containers prevent test pollution and make tests independent.

## 9. Add Observability to DI

Hook into container events to log or measure dependency resolution:

```typescript
const stop = container.on('resolved', ({ key, fromCache }) => {
  const name = typeof key === 'string' ? key : key.name;
  logger.debug(`Resolved ${name} (cached=${fromCache})`);
});

// Stop listening if needed
stop();
```

**Why:** Observability helps debug missing registrations, unexpected transient resolutions, and slow dependency graphs in production.

## Summary Checklist

- ✅ Decorate all services with `@Container()`
- ✅ Use constructor injection for mandatory dependencies
- ✅ Keep property injection minimal (optional dependencies only)
- ✅ Don't import reflect-metadata
- ✅ Use interfaces for flexibility
- ✅ Default to singletons for stateless services
- ✅ Use transient for stateful services
- ✅ Validate services at startup
- ✅ Use factory functions for configuration
- ✅ Organize by feature
- ✅ Keep services focused
- ✅ Document dependencies
- ✅ Avoid circular dependencies
- ✅ Test with isolated containers
- ✅ Add observability via container events

## Next Steps

- [Testing](testing.md) - Learn how to test services effectively
- [Error Handling](error-handling.md) - Handle errors properly
