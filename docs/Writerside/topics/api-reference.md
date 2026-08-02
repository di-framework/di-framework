# API Reference

Complete reference for all APIs provided by the DI framework.

## Decorators

### @Container(options?)

Marks a class as injectable and automatically registers it with the DI container.

**Options:**

- `singleton?: boolean` (default: `true`) - Create a new instance each time or reuse the same instance
- `container?: DIContainer` - Specify a custom container (defaults to global container)

> **Note:** Import as `import { Container as DIContainer } from '@di-framework/di-framework/container'` to avoid name collision with the `@Container` decorator.

**Example:**

```typescript
import { Container } from '@di-framework/di-framework/decorators';

// Singleton service (default)
@Container()
export class DatabaseService {
  connect() {
    console.log('Connected');
  }
}

// Non-singleton service
@Container({ singleton: false })
export class RequestScopedService {
  // New instance created for each resolution
}

// Custom container
import { Container as DIContainer } from '@di-framework/di-framework/container';
const customContainer = new DIContainer();

@Container({ container: customContainer })
export class CustomService {
  // Registered in custom container
}
```

### @Component(target)

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
  private db!: DatabaseService;
}
```

**Example - Factory Service:**

```typescript
@Container()
export class UserService {
  constructor(@Component('config') private config: any) {}
}
```

### @Telemetry(options?)

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

### @TelemetryListener()

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

### @Publisher(optionsOrEvent)

Marks a method to publish a custom event on the container upon invocation. This is useful for cross-platform event-driven architectures.

**Parameters:**

- `optionsOrEvent` - A string representing the event name, or an options object.

**Options:**

- `event: string` - The custom event name.
- `phase?: "before" | "after" | "both"` (default: `"after"`) - When to emit the event relative to method invocation.
- `logging?: boolean` (default: `false`) - Optional console logging for debug purposes.

**Example:**

```typescript
@Container()
export class UserService {
  @Publisher('user.created')
  createUser(name: string) {
    return { id: 1, name };
  }
}
```

### @Subscriber(event)

Marks a method to subscribe to a custom event emitted on the container. The decorated method will automatically receive the published payload when the event occurs.

**Parameters:**

- `event: string` - The custom event name to listen for.

**Example:**

```typescript
@Container()
export class AuditService {
  @Subscriber('user.created')
  onUserCreated(event: any) {
    console.log('User created:', event.result);
  }
}
```

## Container API

### Getting a container instance

To interact with the container, you can either obtain the shared global instance via a function, or import the shared instance directly.

Option A — using a function:

```typescript
import { useContainer } from '@di-framework/di-framework/container';
const container = useContainer();
```

Option B — using a named import:

```typescript
import { container } from '@di-framework/di-framework/container';
```

Note: Prefer Option A when you want to make the acquisition explicit in your code examples; both options reference the same singleton instance by default.

### useContainer()

Returns the global DI container instance.

**Returns:** `Container`

**Example:**

```typescript
import { useContainer } from '@di-framework/di-framework/container';

const container = useContainer();
```

### container.register(serviceClass, options?)

Manually register a service class.

**Parameters:**

- `serviceClass` - The class to register
- `options?` - Registration options
  - `singleton?: boolean` (default: `true`)

**Example:**

```typescript
container.register(UserService, { singleton: true });
```

### container.registerFactory(name, factory, options?)

Register a service using a factory function.

**Parameters:**

- `name: string` - Identifier for the service
- `factory: () => T` - Factory function that creates the service instance
- `options?` - Registration options
  - `singleton?: boolean` (default: `true`)

**Example:**

```typescript
container.registerFactory(
  'config',
  () => ({
    apiKey: process.env.API_KEY,
    dbUrl: process.env.DATABASE_URL,
  }),
  { singleton: true },
);

// Use in services
@Container()
export class UserService {
  constructor(@Component('config') private config: any) {}
}
```

### container.resolve(serviceClass)

Resolve and get an instance of a service.

**Parameters:**

- `serviceClass` - The class or string identifier to resolve

**Returns:** Instance of the service with all dependencies injected

**Example:**

```typescript
// By class
const userService = container.resolve<UserService>(UserService);

// By name (for factory-registered services)
const config = container.resolve('config');
```

### container.has(serviceClass)

Check if a service is registered in the container.

**Parameters:**

- `serviceClass` - The class or string identifier to check

**Returns:** `boolean`

**Example:**

```typescript
if (container.has(UserService)) {
  const service = container.resolve(UserService);
}
```

### container.getServiceNames()

Get all registered service names.

**Returns:** `string[]` - Array of all registered service identifiers

**Example:**

```typescript
const names = container.getServiceNames();
console.log(names); // ['DatabaseService', 'UserService', ...]
```

### container.on(event, listener) / container.off(event, listener)

Subscribe to container lifecycle events (observer pattern). Returns an unsubscribe function from `on`.

**Events:**

- `registered` - `{ key, singleton, kind }`
- `resolved` - `{ key, instance, singleton, fromCache }`
- `constructed` - `{ key, instance, overrides }`
- `cleared` - `{ count }`
- `telemetry` - `{ className, methodName, args, startTime, endTime, result, error }`

**Example:**

```typescript
const stop = container.on('resolved', ({ key, fromCache }) => {
  const name = typeof key === 'string' ? key : key.name;
  console.log(`Resolved ${name} (from cache: ${fromCache})`);
});

// Later, to unsubscribe
stop();
```

### container.construct(serviceClass, overrides?)

Create a fresh instance without registering it, while still resolving dependencies. Use `overrides` to supply specific constructor arguments (by index) such as primitives or config values.

**Example:**

```typescript
import { Component } from '@di-framework/di-framework/decorators';
import { container } from '@di-framework/di-framework/container';
import { LoggerService } from '../../packages/examples/services/LoggerService';

class Greeter {
  constructor(
    @Component(LoggerService) private logger: LoggerService,
    private greeting: string,
  ) {}
}

const greeter = container.construct(Greeter, { 1: 'Hello from config' });
```

### container.fork(options?)

Clone all registrations into a new container (prototype pattern). Pass `{ carrySingletons: true }` to reuse existing singleton instances; default is to start with fresh instances.

**Example:**

```typescript
const child = container.fork({ carrySingletons: true });
const app = child.resolve(ApplicationContext); // shares singletons, isolated registrations
```

## Lifecycle Methods

Services can optionally implement lifecycle methods that are called by the framework or your application code.

### setEnv(env: Record<string, any>)

Called to initialize environment-specific configuration.

**Example:**

```typescript
@Container()
export class DatabaseService {
  setEnv(env: Record<string, any>) {
    console.log('DB URL:', env.DATABASE_URL);
  }
}

const db = container.resolve(DatabaseService);
db.setEnv(process.env);
```

### setCtx(context: any)

Called to set execution context (e.g., request context).

**Example:**

```typescript
@Container()
export class RequestService {
  setCtx(context: any) {
    console.log('Context:', context);
  }
}

const service = container.resolve(RequestService);
service.setCtx({ userId: '123', requestId: 'abc' });
```

## Types

### Container

The DI container class.

```typescript
class Container {
  register<T>(serviceClass: new (...args: any[]) => T, options?: { singleton?: boolean }): void;
  registerFactory<T>(name: string, factory: () => T, options?: { singleton?: boolean }): void;
  resolve<T>(serviceClass: new (...args: any[]) => T | string): T;
  has(serviceClass: any): boolean;
  getServiceNames(): string[];
}
```

## Next Steps

- [Advanced Usage](advanced-usage.md) - Learn advanced patterns and techniques
- [Error Handling](error-handling.md) - Understand error scenarios and how to handle them
- [Testing](testing.md) - Learn how to test services with the DI framework
