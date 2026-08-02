# @di-framework/core

[![CI](https://github.com/di-framework/di-framework/actions/workflows/ci.yml/badge.svg)](https://github.com/di-framework/di-framework/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/di-framework.svg)](https://www.npmjs.com/package/di-framework)
[![license](https://img.shields.io/github/license/di-framework/di-framework.svg)](LICENSE)

A lightweight, type-safe Dependency Injection framework for TypeScript using decorators. This framework automatically manages service instantiation, dependency resolution, and lifecycle management.

## Installation

No external dependencies required! The framework works with SWC and TypeScript's native decorator support.

Just ensure you have:

- TypeScript 5.0+
- SWC or TypeScript compiler with `experimentalDecorators` and `emitDecoratorMetadata` enabled

The decorators are fully integrated with SWC's native support - no need for `reflect-metadata` or any other polyfill.

## Quick Start

### 1. Basic Service

```typescript
import { Container } from '@di-framework/core/decorators';

@Container()
export class DatabaseService {
  connect(): void {
    console.log('Connected to database');
  }
}
```

### 2. Service with Dependencies

```typescript
import { Container, Component } from '@di-framework/core/decorators';
import { DatabaseService } from './services/DatabaseService';

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

Note: Property injection is used for all dependencies. This works seamlessly with SWC and TypeScript's native decorator support.

### 3. Resolve Services

```typescript
import { useContainer } from '@di-framework/core/container';
import { UserService } from './services/UserService';

const container = useContainer();
const userService = container.resolve<UserService>(UserService);

// All dependencies are automatically injected!
userService.getUser('123');
```

## API Reference

### `@Container(options?)`

Marks a class as injectable and automatically registers it with the DI container.

**Options:**

- `singleton?: boolean` (default: `true`) - Create a new instance each time or reuse the same instance
- `container?: DIContainer` - Specify a custom container (defaults to global container)
  - Note: Import as `import { Container as DIContainer } from '@di-framework/core/container'` to avoid name collision with the `@Container` decorator.

**Example:**

```typescript
@Container({ singleton: false })
export class RequestScopedService {
  // New instance created for each resolution
}
```

### `@Component(target)`

Marks a constructor parameter or property for dependency injection.

**Parameters:**

- `target` - The class to inject or a string identifier for factory-registered services

**Example - Constructor Parameter:**

```typescript
@Container()
export class OrderService {
  constructor(@Component(DatabaseService) private db: DatabaseService) {}
}
```

**Example - Property Injection:**

```typescript
@Container()
export class ReportService {
  @Component(DatabaseService)
  private db: DatabaseService;
}
```

### `@Telemetry(options?)`

Marks a method for telemetry tracking. When called, it emits a `telemetry` event on the container. Works with both synchronous and asynchronous methods.

**Options:**

- `logging?: boolean` (default: `false`) - If true, logs the method execution details (status and duration) to the console.

**Example:**

```typescript
@Container()
export class ApiService {
  @Telemetry({ logging: true })
  async fetchData(id: string) {
    // ...
  }
}
```

### `@TelemetryListener()`

Marks a method as a listener for telemetry events. The method will be automatically registered to the container's `telemetry` event when the service is instantiated.

**Example:**

```typescript
@Container()
export class MonitoringService {
  @TelemetryListener()
  onTelemetry(event: any) {
    console.log(
      `Method ${event.className}.${event.methodName} took ${event.endTime - event.startTime}ms`,
    );
  }
}
```

### `useContainer()`

Returns the global DI container instance.

```typescript
import { useContainer } from '@di-framework/core/container';

const container = useContainer();
```

### `container.register(serviceClass, options?)`

Manually register a service class.

```typescript
container.register(UserService, { singleton: true });
```

### `container.registerFactory(name, factory, options?)`

Register a service using a factory function.

```typescript
container.registerFactory(
  'config',
  () => ({
    apiKey: process.env.API_KEY,
    dbUrl: process.env.DATABASE_URL,
  }),
  { singleton: true },
);
```

### `container.resolve(serviceClass)`

Resolve and get an instance of a service.

```typescript
const userService = container.resolve<UserService>(UserService);
// or by name
const config = container.resolve('config');
```

### `container.has(serviceClass)`

Check if a service is registered.

```typescript
if (container.has(UserService)) {
  const service = container.resolve(UserService);
}
```

### `container.getServiceNames()`

Get all registered service names.

```typescript
const names = container.getServiceNames();
console.log(names); // ['DatabaseService', 'UserService', ...]
```

### `container.on(event, listener)`

Subscribe to DI container lifecycle events (observer pattern).

**Events:**

- `registered` - fired when a class or factory is registered
- `resolved` - fired whenever a service is resolved (cached or fresh)
- `constructed` - fired when `construct()` creates a new instance
- `cleared` - fired when the container is cleared

**Example:**

```typescript
const unsubscribe = container.on('resolved', ({ key, fromCache }) => {
  console.log(`Resolved ${typeof key === 'string' ? key : key.name} (fromCache=${fromCache})`);
});

unsubscribe(); // stop listening
```

### `container.construct(serviceClass, overrides?)`

Create a fresh instance without registering it, while still honoring dependency injection. Useful for constructor-pattern scenarios where you need to supply specific primitives/config values.

```typescript
import { Component } from '@di-framework/core/decorators';
import { LoggerService } from '@di-framework/core/services/LoggerService';

class Greeter {
  constructor(
    @Component(LoggerService) private logger: LoggerService,
    private greeting: string,
  ) {}
}

const greeter = container.construct(Greeter, { 1: 'hello world' });
```

### `container.fork(options?)`

Clone the container registrations (prototype pattern) into a new container. Pass `{ carrySingletons: true }` to reuse existing singleton instances; default is to start with fresh instances.

```typescript
const testContainer = container.fork({ carrySingletons: false });
```

## Advanced Examples

### Multiple Dependencies

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

### Transient (Non-Singleton) Services

```typescript
@Container({ singleton: false })
export class RequestContext {
  id = Math.random().toString();

  constructor(@Component(LoggerService) private logger: LoggerService) {
    this.logger.log(`Request context created: ${this.id}`);
  }
}

// Each resolve creates a new instance
const ctx1 = container.resolve(RequestContext); // new instance
const ctx2 = container.resolve(RequestContext); // different instance
```

### Lifecycle Methods

Services can optionally implement lifecycle methods:

```typescript
@Container()
export class DatabaseService {
  private connected = false;

  setEnv(env: Record<string, any>) {
    // Called to initialize environment-specific config
    console.log('DB URL:', env.DATABASE_URL);
  }

  setCtx(context: any) {
    // Called to set execution context
    console.log('Context:', context);
  }

  connect() {
    this.connected = true;
  }
}

// Calling lifecycle methods
const db = container.resolve(DatabaseService);
db.setEnv(process.env);
db.setCtx({ userId: '123' });
db.connect();
```

### Factory Functions

```typescript
container.registerFactory(
  'apiClient',
  () => {
    return new HttpClient({
      baseUrl: process.env.API_URL,
      timeout: 5000,
    });
  },
  { singleton: true },
);

// Use in services
@Container()
export class UserService {
  constructor(@Component('apiClient') private api: any) {}
}
```

## How It Works

1. **Decoration**: When you decorate a class with `@Container()`, the decorator registers it with the global container
2. **Registration**: The class is stored in the container with metadata about its dependencies
3. **Resolution**: When you call `container.resolve(ServiceClass)`:
   - The container creates a new instance (or returns existing singleton)
   - It examines the constructor parameters and their types
   - It recursively resolves each dependency
   - Dependencies are injected into the constructor
   - The configured instance is returned
4. **Caching**: Singleton instances are cached and reused

## Comparison with SAMPLE.ts

### Before (Manual - SAMPLE.ts)

```typescript
const createServerContext = (env, ctx) => {
  if (!instanceState.member) {
    const contextInstance = Context.create({
      contactService: ContactService.create({}),
      assetService: AssetService.create({}),
      transactionService: TransactionService.create({}),
      // ... 20+ more services manually created and wired
      chatService: ChatService.create({
        openAIApiKey: env.OPENAI_API_KEY,
        // ... manual configuration
      }),
    });
    instanceState.member = contextInstance;
  }

  instanceState.member.setEnv(env);
  instanceState.member.setCtx(ctx);
  // ... manual dependency wiring
  instanceState.member.knowledgeService.setAttachmentService(
    instanceState.member.attachmentService,
  );
  return instanceState.member;
};
```

### After (DI Framework)

```typescript
@Container()
export class ApplicationContext {
  constructor(
    @Component(ContactService) private contactService: ContactService,
    @Component(AssetService) private assetService: AssetService,
    @Component(TransactionService)
    private transactionService: TransactionService,
    // ... all services automatically injected
    @Component(ChatService) private chatService: ChatService,
  ) {}

  setEnv(env: Record<string, any>) {
    // Services are already available via constructor injection
    this.chatService.initialize(env.OPENAI_API_KEY);
  }

  setCtx(ctx: any) {
    // All services have access to context
  }
}

// Usage
const container = useContainer();
const appContext = container.resolve(ApplicationContext);
appContext.setEnv(env);
appContext.setCtx(ctx);
```

**Benefits:**

- No manual service instantiation
- No manual dependency wiring
- Automatic singleton management
- Type-safe dependency resolution
- Easier to test (mock services simply by registering test implementations)
- Scales better as services grow

## Error Handling

### Circular Dependencies

```typescript
// This will be detected and throw an error:
@Container()
class ServiceA {
  constructor(@Component(ServiceB) private b: ServiceB) {}
}

@Container()
class ServiceB {
  constructor(@Component(ServiceA) private a: ServiceA) {}
}

// Error: Circular dependency detected while resolving ServiceA
```

### Unregistered Services

```typescript
@Container()
class MyService {
  constructor(@Component(UnregisteredService) private s: UnregisteredService) {}
}

// Error: Service 'UnregisteredService' is not registered in the DI container
```

## Best Practices

1. **Mark all services with `@Container()`** - Makes dependency management explicit
2. **Use constructor injection** - Preferred over property injection for mandatory dependencies
3. **Use property injection for optional dependencies** - Keep it minimal
4. **No need to import reflect-metadata** - This framework uses a lightweight metadata store
5. **Separate service interfaces from implementations** - For easier testing
6. **Use singletons for stateless services** - Most services should be singletons
7. **Use transient (non-singleton) for stateful services** - Request/session scoped services

## Testing

```typescript
// Create a test container
import { Container as DIContainer } from '@di-framework/core/container';

const testContainer = new DIContainer();

// Register mock implementations
class MockDatabaseService {
  query() {
    return { mock: true };
  }
}

testContainer.register(MockDatabaseService);

// Register dependencies
testContainer.register(UserService);

// Test the service with mocked dependencies
const userService = testContainer.resolve(UserService);
expect(userService.getUser('1')).toEqual({ mock: true });
```

## License

MIT
