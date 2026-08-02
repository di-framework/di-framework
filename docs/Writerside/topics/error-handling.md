# Error Handling

Understanding and handling errors in the DI framework.

## Common Errors

### Circular Dependencies

The framework automatically detects circular dependencies and throws an error:

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

// Attempting to resolve either service will throw:
// Error: Circular dependency detected while resolving ServiceA
```

**How to fix:**

1. **Refactor to remove the circular dependency** - Extract common logic to a third service
2. **Use property injection** - Delay dependency resolution
3. **Rethink your architecture** - Circular dependencies often indicate a design issue

**Example refactoring:**

```typescript
// Before (circular):
@Container()
class ServiceA {
  constructor(@Component(ServiceB) private b: ServiceB) {}
}

@Container()
class ServiceB {
  constructor(@Component(ServiceA) private a: ServiceA) {}
}

// After (refactored):
@Container()
class SharedService {
  // Common logic extracted here
}

@Container()
class ServiceA {
  constructor(@Component(SharedService) private shared: SharedService) {}
}

@Container()
class ServiceB {
  constructor(@Component(SharedService) private shared: SharedService) {}
}
```

### Unregistered Services

Attempting to resolve or inject a service that hasn't been registered will throw an error:

```typescript
@Container()
class MyService {
  constructor(@Component(UnregisteredService) private s: UnregisteredService) {}
}

// Error: Service 'UnregisteredService' is not registered in the DI container
```

**How to fix:**

1. **Register the service** - Add `@Container()` decorator to the service class
2. **Check your imports** - Ensure the service file is imported somewhere in your application
3. **For factory services** - Ensure `registerFactory()` was called before resolution

**Example fix:**

```typescript
// Add the @Container() decorator
@Container()
export class UnregisteredService {
  // Service implementation
}

// Or register manually
container.register(UnregisteredService);

// Or register as factory
container.registerFactory('serviceName', () => new UnregisteredService());
```

### Missing Decorator Metadata

If decorators aren't working, check your TypeScript/SWC configuration:

```typescript
// This won't work without proper configuration
@Container()
class MyService {
  constructor(@Component(DatabaseService) private db: DatabaseService) {}
}

// Error: Cannot read properties of undefined (reading 'db')
```

**How to fix:**

Ensure your `../../../tsconfig.json` has:

```json
{
  "compilerOptions": {
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true
  }
}
```

Or for SWC (`.swcrc`):

```json
{
  "jsc": {
    "parser": {
      "decorators": true
    },
    "transform": {
      "legacyDecorator": true,
      "decoratorMetadata": true
    }
  }
}
```

## Error Prevention

### Check Before Resolving

Use `container.has()` to check if a service is registered:

```typescript
if (container.has(UserService)) {
  const service = container.resolve(UserService);
} else {
  console.warn('UserService not registered');
}
```

### Validate Dependencies at Startup

Create a startup validation routine:

```typescript
@Container()
export class StartupValidator {
  validateServices() {
    const requiredServices = [DatabaseService, AuthService, CacheService, LoggerService];

    const missing = requiredServices.filter((service) => !container.has(service));

    if (missing.length > 0) {
      throw new Error(`Missing required services: ${missing.map((s) => s.name).join(', ')}`);
    }
  }
}

// Run at application startup
const validator = container.resolve(StartupValidator);
validator.validateServices();
```

### Debug Service Registration

List all registered services for debugging:

```typescript
const serviceNames = container.getServiceNames();
console.log('Registered services:', serviceNames);
```

## Runtime Errors

### Handling Service Initialization Errors

Services may fail during initialization:

```typescript
@Container()
export class DatabaseService {
  constructor() {
    // This might throw
    this.connect();
  }

  private connect() {
    throw new Error('Connection failed');
  }
}

// Wrap resolution in try-catch
try {
  const db = container.resolve(DatabaseService);
} catch (error) {
  console.error('Failed to initialize DatabaseService:', error);
  // Handle error appropriately
}
```

### Graceful Degradation

Provide fallback implementations:

```typescript
// Try to use preferred service, fall back to alternative
let logger;
try {
  logger = container.resolve(ProductionLogger);
} catch (error) {
  console.warn('Production logger unavailable, using console');
  logger = container.resolve(ConsoleLogger);
}
```

## Testing Error Scenarios

Test error handling in your services:

```typescript
import { Container as DIContainer } from '@di-framework/core/container';

describe('ServiceA', () => {
  it('should handle missing dependencies gracefully', () => {
    const testContainer = new DIContainer();

    // Don't register required dependency
    testContainer.register(ServiceA);

    expect(() => {
      testContainer.resolve(ServiceA);
    }).toThrow("Service 'ServiceB' is not registered");
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

## Best Practices for Error Handling

1. **Validate at startup** - Catch configuration errors early
2. **Use try-catch for resolution** - Handle initialization failures
3. **Check service availability** - Use `container.has()` when unsure
4. **Log errors clearly** - Include service names and context
5. **Provide fallbacks** - Design for graceful degradation
6. **Test error scenarios** - Ensure your error handling works

## Next Steps

- [Best Practices](best-practices.md) - Learn recommended patterns and approaches
- [Testing](testing.md) - Learn how to test services with error handling
