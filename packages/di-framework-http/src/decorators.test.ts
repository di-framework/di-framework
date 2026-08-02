import { describe, expect, it } from 'bun:test';
import { useContainer } from '@di-framework/di-framework/container';
import { Component } from '@di-framework/di-framework/decorators';
import { Controller, Endpoint, SCHEMAS } from './decorators.ts';
import registry from './registry.ts';

describe('Decorators', () => {
  it('should register a controller and its endpoints', () => {
    const initialSize = registry.getTargets().size;

    @Controller()
    class TestController {
      @Endpoint({ summary: 'Test endpoint' })
      static test = { isEndpoint: true, path: '/test', method: 'get' };
    }

    expect(registry.getTargets().has(TestController)).toBe(true);
    // @ts-expect-error
    expect(TestController.isController).toBe(true);
    expect(TestController.test.isEndpoint).toBe(true);
    // @ts-expect-error
    expect(TestController.test.metadata.summary).toBe('Test endpoint');

    expect(registry.getTargets().size).toBeGreaterThan(initialSize);
  });

  it('should work as a class decorator for Endpoint', () => {
    @Endpoint({ summary: 'Class level' })
    class ClassEndpoint {}

    expect(registry.getTargets().has(ClassEndpoint)).toBe(true);
    // @ts-expect-error
    expect(ClassEndpoint.isEndpoint).toBe(true);
    // @ts-expect-error
    expect(ClassEndpoint.metadata.summary).toBe('Class level');
  });

  it('should work on instance methods (via prototype)', () => {
    class InstanceController {
      @Endpoint({ summary: 'Instance method' })
      method() {}
    }

    expect(registry.getTargets().has(InstanceController)).toBe(true);
    // @ts-expect-error
    expect(InstanceController.prototype.method.isEndpoint).toBe(true);
  });

  it('should inject static properties on Controller classes', () => {
    class InjectedService {
      value = 42;
    }
    useContainer().register(InjectedService);

    @Controller()
    class InjectedController {
      @Component(InjectedService)
      static service: InjectedService;
    }

    expect(InjectedController.service).toBeDefined();
    expect(InjectedController.service.value).toBe(42);
  });

  it('should extract schemas from Endpoint metadata and store them via SCHEMAS symbol', () => {
    class SchemaEndpoint {
      @Endpoint({
        responses: {
          '200': {
            description: 'A successful response',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/MyModel' },
              },
            },
          },
        },
        requestBody: {
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/MyRequest' },
            },
          },
        },
      })
      static myEndpoint() {}
    }

    const schemas = (SchemaEndpoint as any)[SCHEMAS];
    expect(schemas).toBeDefined();
    expect(schemas.has('MyModel')).toBe(true);
    expect(schemas.has('MyRequest')).toBe(true);
    expect(schemas.size).toBe(2);
  });
});
