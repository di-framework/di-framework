# Testing

Learn how to test services effectively with the DI framework.

## Basic Testing Setup

Create isolated test containers to avoid polluting the global container:

```typescript
import { Container as DIContainer } from '@di-framework/di-framework/container';
import { describe, it, expect, beforeEach } from 'bun:test';

describe('UserService', () => {
  let testContainer: DIContainer;

  beforeEach(() => {
    // Create a fresh container for each test
    testContainer = new DIContainer();
  });

  it('should create user', () => {
    // Register services
    testContainer.register(DatabaseService);
    testContainer.register(UserService);

    // Resolve and test
    const userService = testContainer.resolve(UserService);
    expect(userService).toBeDefined();
  });
});
```

## Mocking Dependencies

Replace real services with mock implementations:

```typescript
// Mock implementation
class MockDatabaseService {
  query(sql: string) {
    return { rows: [{ id: '1', name: 'Test User' }] };
  }
}

describe('UserService', () => {
  let testContainer: DIContainer;

  beforeEach(() => {
    testContainer = new DIContainer();

    // Register mock instead of real service
    testContainer.register(MockDatabaseService);
    testContainer.register(UserService);
  });

  it('should return user from database', () => {
    const userService = testContainer.resolve(UserService);
    const user = userService.getUser('1');

    expect(user.rows[0].name).toBe('Test User');
  });
});
```

## Testing with Factory Services

Mock configuration and factory-registered services:

```typescript
describe('UserService with config', () => {
  let testContainer: DIContainer;

  beforeEach(() => {
    testContainer = new DIContainer();

    // Register test configuration
    testContainer.registerFactory(
      'config',
      () => ({
        apiUrl: 'http://test.example.com',
        timeout: 1000,
      }),
      { singleton: true },
    );

    testContainer.register(UserService);
  });

  it('should use test configuration', () => {
    const userService = testContainer.resolve(UserService);
    const config = testContainer.resolve('config');

    expect(config.apiUrl).toBe('http://test.example.com');
  });
});
```

## Testing Dependency Injection

Verify that dependencies are correctly injected:

```typescript
describe('OrderService dependencies', () => {
  it('should inject all required dependencies', () => {
    const testContainer = new DIContainer();

    testContainer.register(DatabaseService);
    testContainer.register(PaymentService);
    testContainer.register(EmailService);
    testContainer.register(OrderService);

    const orderService = testContainer.resolve(OrderService);

    // Verify service is properly initialized
    expect(orderService).toBeDefined();
    expect(() => orderService.createOrder({})).not.toThrow();
  });
});
```

## Testing Singleton vs Transient

Verify singleton and transient behavior:

```typescript
describe('Service lifecycle', () => {
  it('should return same instance for singletons', () => {
    const testContainer = new DIContainer();
    testContainer.register(DatabaseService, { singleton: true });

    const instance1 = testContainer.resolve(DatabaseService);
    const instance2 = testContainer.resolve(DatabaseService);

    expect(instance1).toBe(instance2);
  });

  it('should return different instances for transient services', () => {
    const testContainer = new DIContainer();
    testContainer.register(RequestContext, { singleton: false });

    const instance1 = testContainer.resolve(RequestContext);
    const instance2 = testContainer.resolve(RequestContext);

    expect(instance1).not.toBe(instance2);
  });
});
```

## Reusing Setup with fork()

Share a seeded container across tests while keeping isolation:

```typescript
import { Container as DIContainer } from '@di-framework/di-framework/container';

const base = new DIContainer();
base.register(DatabaseService);
base.register(LoggerService);

beforeEach(() => {
  testContainer = base.fork({ carrySingletons: true }); // reuse expensive singletons
});
```

**Why:** Avoid re-registering common services while ensuring tests cannot mutate each other's registrations.

## Construct Instances with Overrides

Build ad-hoc instances for tests without registering them:

```typescript
class Greeter {
  constructor(
    @Component(LoggerService) private logger: LoggerService,
    private greeting: string,
  ) {}
}

it('should allow override of primitive args', () => {
  const c = new DIContainer();
  c.register(LoggerService);
  const greeter = c.construct(Greeter, { 1: 'hello test' });
  expect(greeter).toBeInstanceOf(Greeter);
});
```

**Why:** Handy for targeted unit tests where you need DI-managed dependencies plus specific literal parameters.

## Testing Publishers and Subscribers

You can verify that events are emitted and received correctly by registering both the publisher and subscriber in a test container:

```typescript
it('should deliver events to subscribers', () => {
  const testContainer = new DIContainer();
  let receivedEvent: any = null;

  @Container()
  class TestSubscriber {
    @Subscriber('test.event')
    onEvent(payload: any) {
      receivedEvent = payload;
    }
  }

  @Container()
  class TestPublisher {
    @Publisher('test.event')
    doWork() {
      return 'done';
    }
  }

  testContainer.register(TestSubscriber);
  testContainer.register(TestPublisher);

  // Resolving the subscriber registers the listener
  testContainer.resolve(TestSubscriber);
  const publisher = testContainer.resolve(TestPublisher);

  publisher.doWork();

  expect(receivedEvent).toBeDefined();
  expect(receivedEvent.methodName).toBe('doWork');
  expect(receivedEvent.result).toBe('done');
});
```

## Testing Telemetry

You can test telemetry by creating a service with `@TelemetryListener` or by subscribing to the container's `telemetry` event:

```typescript
it('should emit telemetry events', async () => {
  const testContainer = new DIContainer();
  let telemetryPayload: any = null;

  testContainer.on('telemetry', (payload) => {
    telemetryPayload = payload;
  });

  testContainer.register(ApiService);
  const api = testContainer.resolve(ApiService);

  await api.fetchData('123');

  expect(telemetryPayload).toBeDefined();
  expect(telemetryPayload.className).toBe('ApiService');
  expect(telemetryPayload.methodName).toBe('fetchData');
  expect(telemetryPayload.endTime - telemetryPayload.startTime).toBeGreaterThanOrEqual(0);
});
```

## Testing Error Scenarios

Test error handling and validation:

```typescript
describe('Error handling', () => {
  it('should throw when service not registered', () => {
    const testContainer = new DIContainer();

    expect(() => {
      testContainer.resolve(UnregisteredService);
    }).toThrow("Service 'UnregisteredService' is not registered");
  });

  it('should detect circular dependencies', () => {
    const testContainer = new DIContainer();
    testContainer.register(ServiceA);
    testContainer.register(ServiceB);

    expect(() => {
      testContainer.resolve(ServiceA);
    }).toThrow('Circular dependency detected');
  });
});
```

## Spy and Stub Pattern

Create spies to verify method calls:

```typescript
class SpyDatabaseService {
  queries: string[] = [];

  query(sql: string) {
    this.queries.push(sql);
    return { rows: [] };
  }
}

describe('UserService with spy', () => {
  it('should call database with correct query', () => {
    const testContainer = new DIContainer();
    testContainer.register(SpyDatabaseService);
    testContainer.register(UserService);

    const userService = testContainer.resolve(UserService);
    const spy = testContainer.resolve(SpyDatabaseService);

    userService.getUser('123');

    expect(spy.queries).toContain("SELECT * FROM users WHERE id = '123'");
  });
});
```

## Testing Async Services

Test services with async operations:

```typescript
class MockAsyncDatabaseService {
  async connect() {
    return Promise.resolve();
  }

  async query(sql: string) {
    return Promise.resolve({ rows: [{ id: '1' }] });
  }
}

describe('Async UserService', () => {
  it('should handle async operations', async () => {
    const testContainer = new DIContainer();
    testContainer.register(MockAsyncDatabaseService);
    testContainer.register(UserService);

    const userService = testContainer.resolve(UserService);
    const user = await userService.getUserAsync('1');

    expect(user.rows).toHaveLength(1);
  });
});
```

## Integration Testing

Test multiple services working together:

```typescript
describe('Order processing integration', () => {
  it('should process complete order flow', async () => {
    const testContainer = new DIContainer();

    // Register all required services
    testContainer.register(MockDatabaseService);
    testContainer.register(MockPaymentService);
    testContainer.register(MockEmailService);
    testContainer.register(OrderService);

    const orderService = testContainer.resolve(OrderService);

    const order = await orderService.createOrder({
      userId: '1',
      items: [{ id: 'item1', quantity: 2 }],
      total: 100,
    });

    expect(order.id).toBeDefined();
    expect(order.status).toBe('completed');
  });
});
```

## Testing Best Practices

### 1. Use Isolated Containers

```typescript
// Good - Fresh container per test
beforeEach(() => {
  testContainer = new DIContainer();
});

// Bad - Shared container
const testContainer = new DIContainer(); // Global
```

### 2. Mock External Dependencies

```typescript
// Good - Mock external services
class MockEmailService {
  async sendEmail(to: string, subject: string) {
    return { success: true, messageId: 'test-123' };
  }
}

// Bad - Using real email service in tests
testContainer.register(RealEmailService); // Will send real emails
```

### 3. Test One Thing at a Time

```typescript
// Good - Focused test
it('should validate user email', () => {
  const validator = testContainer.resolve(UserValidator);
  expect(() => validator.validateEmail('invalid')).toThrow();
});

// Bad - Testing multiple things
it('should create user and send email and log activity', () => {
  // Too much in one test
});
```

### 4. Provide Clear Test Data

```typescript
// Good - Clear test data
const testUser = {
  id: '1',
  name: 'Test User',
  email: 'test@example.com',
};

// Bad - Unclear test data
const testUser = { id: '1', n: 'TU', e: 't@e.c' };
```

## Complete Test Example

Here's a complete testing example:

```typescript
import { Container as DIContainer } from '@di-framework/di-framework/container';
import { describe, it, expect, beforeEach } from 'bun:test';

// Mock services
class MockDatabaseService {
  private users = new Map([['1', { id: '1', name: 'John Doe', email: 'john@example.com' }]]);

  query(sql: string) {
    const match = sql.match(/id = '(\d+)'/);
    if (match) {
      const user = this.users.get(match[1]);
      return { rows: user ? [user] : [] };
    }
    return { rows: [] };
  }
}

class MockLoggerService {
  logs: string[] = [];

  log(message: string) {
    this.logs.push(message);
  }
}

// Test suite
describe('UserService', () => {
  let testContainer: DIContainer;

  beforeEach(() => {
    testContainer = new DIContainer();
    testContainer.register(MockDatabaseService);
    testContainer.register(MockLoggerService);
    testContainer.register(UserService);
  });

  it('should get user by id', () => {
    const userService = testContainer.resolve(UserService);
    const user = userService.getUser('1');

    expect(user.rows[0].name).toBe('John Doe');
  });

  it('should log user retrieval', () => {
    const userService = testContainer.resolve(UserService);
    const logger = testContainer.resolve(MockLoggerService);

    userService.getUser('1');

    expect(logger.logs).toContain('Getting user: 1');
  });

  it('should return empty for non-existent user', () => {
    const userService = testContainer.resolve(UserService);
    const user = userService.getUser('999');

    expect(user.rows).toHaveLength(0);
  });
});
```

## Next Steps

- [Best Practices](best-practices.md) - Review recommended patterns
- [Error Handling](error-handling.md) - Learn about error scenarios
- [API Reference](api-reference.md) - Complete API documentation
