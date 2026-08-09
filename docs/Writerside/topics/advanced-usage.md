# Advanced Usage

Learn advanced patterns and techniques for using di-framework effectively.

## Transient (Non-Singleton) Services

By default, all services are singletons - the same instance is reused. For services that need a new instance each time, use `singleton: false`:

```typescript
import { useContainer } from '@di-framework/core/container';
const container = useContainer();

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
console.log(ctx1.id !== ctx2.id); // true
```

**When to use transient services:**

- Request-scoped services
- Session-scoped services
- Services with mutable state that shouldn't be shared
- Services that need fresh data on each use

## Factory Functions

Register services using factory functions for complex initialization logic:

```typescript
import { useContainer } from '@di-framework/core/container';
const container = useContainer();

container.registerFactory(
  'apiClient',
  () => {
    return new HttpClient({
      baseUrl: process.env.API_URL,
      timeout: 5000,
      headers: {
        Authorization: `Bearer ${process.env.API_TOKEN}`,
      },
    });
  },
  { singleton: true },
);

// Use in services
@Container()
export class UserService {
  constructor(@Component('apiClient') private api: any) {}

  async getUser(id: string) {
    return this.api.get(`/users/${id}`);
  }
}
```

**Factory function benefits:**

- Initialize services with environment variables
- Create instances with complex configuration
- Conditionally create different implementations
- Integrate third-party libraries

## Repository Pattern (`@di-framework/repo`)

For larger applications, using the Repository pattern with `@di-framework/repo` helps maintain a clean separation between business logic and data access.

### Standard Repository

```typescript
import { Repository, InMemoryRepository } from '@di-framework/repo';

@Repository()
export class UserRepository extends InMemoryRepository<User, number> {
  async findByEmail(email: string): Promise<User | null> {
    const all = await this.findAll();
    return all.find((u) => u.email === email) || null;
  }
}
```

### Soft Delete Support

```typescript
import { SoftDeleteRepository, SoftDeletable } from '@di-framework/repo';

interface Product extends SoftDeletable {
  id: string;
  name: string;
}

@Repository()
export class ProductRepository extends SoftDeleteRepository<Product, string> {
  // Implement required abstract methods for your adapter
}
```

See the [Repositories documentation](repositories.md) for more details.

## Lifecycle Methods

Services can implement lifecycle methods for initialization and context management:

```typescript
import { useContainer } from '@di-framework/core/container';
const container = useContainer();

@Container()
export class DatabaseService {
  private connected = false;
  private dbUrl: string = '';

  setEnv(env: Record<string, any>) {
    // Called to initialize environment-specific config
    this.dbUrl = env.DATABASE_URL;
    console.log('DB URL configured:', this.dbUrl);
  }

  setCtx(context: any) {
    // Called to set execution context
    console.log('Context set:', context);
  }

  connect() {
    this.connected = true;
    console.log('Connected to:', this.dbUrl);
  }
}

// Usage
const db = container.resolve(DatabaseService);
db.setEnv(process.env);
db.setCtx({ userId: '123' });
db.connect();
```

## Multiple Dependencies

Inject multiple dependencies using constructor parameters:

```typescript
@Container()
export class ApplicationContext {
  constructor(
    @Component(DatabaseService) private db: DatabaseService,
    @Component(LoggerService) private logger: LoggerService,
    @Component(AuthService) private auth: AuthService,
    @Component(CacheService) private cache: CacheService,
    @Component(EmailService) private email: EmailService,
  ) {}

  async initialize() {
    this.logger.log('Initializing application...');
    await this.db.connect();
    this.auth.setup();
    this.cache.connect();
  }
}
```

## Event-Driven Architecture

The framework supports cross-platform event-driven patterns using the `@Publisher` and `@Subscriber` decorators, allowing services to communicate loosely through the container.

### Emitting Events with @Publisher

Use `@Publisher` to emit a custom event when a method is called. By default, it emits after the method executes successfully or fails.

```typescript
@Container()
export class UserService {
  @Publisher({ event: 'user.created', phase: 'after', logging: true })
  async createUser(dto: any) {
    // ...
    return { id: 1, ...dto };
  }
}
```

### Receiving Events with @Subscriber

Use `@Subscriber` to automatically listen for custom events. Subscribed methods receive a payload containing the `className`, `methodName`, `args`, `startTime`, `endTime`, `result`, and `error`.

```typescript
@Container()
export class NotificationService {
  @Subscriber('user.created')
  onUserCreated(event: any) {
    if (event.result) {
      console.log(`Sending welcome email to ${event.result.name}`);
    }
  }
}
```

To publish those same events to Kafka or NATS (or consume remote topics back onto the bus), use [`@di-framework/events`](events.md). For WebSocket, TCP, or UDP peers (including a secure channel and Cloudflare Workers / Durable Objects), use [`@di-framework/socket`](socket.md).

## Telemetry and Monitoring

The framework provides built-in support for tracking method execution using the `@Telemetry` and `@TelemetryListener` decorators.

### Tracking Methods with @Telemetry

Use `@Telemetry` to track execution of any method in an injectable service. It automatically captures:

- Start and end times (duration)
- Method arguments
- Return value
- Errors (if the method throws)

```typescript
@Container()
export class ApiService {
  @Telemetry({ logging: true }) // Logs duration and status to console
  async fetchData(id: string) {
    const response = await fetch(`https://api.example.com/data/${id}`);
    return response.json();
  }
}
```

### Listening to Events with @TelemetryListener

Use `@TelemetryListener` to create monitoring services that react to telemetry events from across your application:

```typescript
@Container()
export class MonitoringService {
  @TelemetryListener()
  onTelemetry(event: any) {
    const { className, methodName, startTime, endTime, error } = event;
    const duration = endTime - startTime;

    if (error) {
      console.error(`Alert: ${className}.${methodName} failed after ${duration}ms:`, error);
    } else {
      console.log(`Metric: ${className}.${methodName} took ${duration}ms`);
    }

    // Send to external monitoring service (e.g., Datadog, Sentry)
    metricsService.timing(`${className}.${methodName}`, duration);
  }
}
```

## Custom Containers

Create isolated containers for different parts of your application:

```typescript
import { Container as DIContainer } from '@di-framework/core/container';

// Create custom containers
const apiContainer = new DIContainer();
const workerContainer = new DIContainer();

// Register services in specific containers
@Container({ container: apiContainer })
export class ApiService {
  // Only available in apiContainer
}

@Container({ container: workerContainer })
export class WorkerService {
  // Only available in workerContainer
}

// Resolve from specific containers
const apiService = apiContainer.resolve(ApiService);
const workerService = workerContainer.resolve(WorkerService);
```

**Use cases for custom containers:**

- Multi-tenant applications
- Plugin systems
- Testing with isolated environments
- Microservices within a monorepo

## Fork Containers (Prototype Pattern)

Clone an existing container and optionally carry over singleton instances:

```typescript
import { useContainer } from '@di-framework/core/container';
const container = useContainer();

// Seed the base container
container.register(DatabaseService);
container.register(LoggerService);
const sharedDb = container.resolve(DatabaseService);

// Create an isolated fork for a tenant/request
const tenantContainer = container.fork({ carrySingletons: true });
tenantContainer.registerFactory('config', () => loadTenantConfig());

// Resolves share the DatabaseService instance but have their own registrations
const tenantCtx = tenantContainer.resolve(ApplicationContext);
```

**Why:** Quickly spin up scoped containers without re-registering every service. Carry over expensive singletons (DB connections) while keeping registrations isolated.

## Observability with Container Events

Use the observer hooks to add diagnostics or metrics around registration and resolution:

```typescript
import { useContainer } from '@di-framework/core/container';
const container = useContainer();

const stop = container.on('resolved', ({ key, singleton, fromCache }) => {
  const name = typeof key === 'string' ? key : key.name;
  metrics.increment('di.resolve', { name, singleton, fromCache });
});

// Later, if needed:
stop();
```

**Use cases:**

- Log or trace dependency graphs during debugging
- Emit metrics for cache hit/miss on singletons
- Enforce policies (e.g., warn on transient resolutions in hot paths)

## Construct with Overrides (Constructor Pattern)

Create fresh instances without registering them, and override constructor arguments for primitives or config:

```typescript
import { Component } from '@di-framework/core/decorators';
import { container } from '@di-framework/core/container';

class EmailService {
  constructor(
    @Component(LoggerService) private logger: LoggerService,
    private sender: string,
  ) {}
}

const emailer = container.construct(EmailService, {
  1: 'no-reply@example.com',
});
```

**Why:** Useful for ad-hoc utilities, one-off jobs, or tests where you need DI-managed dependencies plus specific literal parameters.

## Configuration Services

For typed, validated configuration from env and files, use [`@di-framework/config`](config.md). A minimal imperative example:

```typescript
import { loadAndRegisterConfig, envSource } from '@di-framework/config';
import { Container, Component } from '@di-framework/core/decorators';

await loadAndRegisterConfig({
  defaults: {
    database: { host: 'localhost', port: 5432 },
  },
  sources: [envSource({ prefix: 'APP_' })],
});

@Container()
export class DatabaseService {
  constructor(@Component('config') private config: { database: { host: string } }) {
    console.log('DB Config:', this.config.database);
  }
}
```

You can still register a plain factory with `registerFactory('config', …)` when you do not need sources or validation.

## Conditional Service Registration

Register different implementations based on environment:

```typescript
import { useContainer } from '@di-framework/core/container';
const container = useContainer();

// Register different implementations
if (process.env.NODE_ENV === 'production') {
  container.registerFactory('logger', () => new ProductionLogger(), {
    singleton: true,
  });
} else {
  container.registerFactory('logger', () => new DevelopmentLogger(), {
    singleton: true,
  });
}

// Services get the right implementation
@Container()
export class UserService {
  constructor(@Component('logger') private logger: any) {
    this.logger.log('UserService initialized');
  }
}
```

## Service Composition

Compose complex services from simpler ones:

```typescript
@Container()
export class DataAccessLayer {
  constructor(
    @Component(DatabaseService) private db: DatabaseService,
    @Component(CacheService) private cache: CacheService,
  ) {}

  async get(key: string) {
    // Try cache first
    const cached = await this.cache.get(key);
    if (cached) return cached;

    // Fall back to database
    const data = await this.db.query(`SELECT * FROM data WHERE key = '${key}'`);
    await this.cache.set(key, data);
    return data;
  }
}

@Container()
export class BusinessLogicLayer {
  constructor(
    @Component(DataAccessLayer) private dal: DataAccessLayer,
    @Component(ValidationService) private validator: ValidationService,
  ) {}

  async processRequest(request: any) {
    this.validator.validate(request);
    return this.dal.get(request.key);
  }
}
```

## Next Steps

- [Error Handling](error-handling.md) - Learn how to handle errors in your DI setup
- [Best Practices](best-practices.md) - Follow recommended patterns
- [Testing](testing.md) - Test your services effectively
