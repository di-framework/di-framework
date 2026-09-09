import { beforeEach, describe, expect, it } from 'bun:test';
import { useContainer } from '../container.js';
import { Container as InjectableContainer } from '../decorators/Container.js';
import {
  ExportService,
  ServiceBinding,
  serviceBindingToken,
} from '../decorators/ServiceBinding.js';
import {
  IncompatibleContractError,
  LocalServiceDevManager,
  MissingBindingError,
  ServiceBindingRuntime,
  TargetUnavailableError,
  UnauthorizedOperationError,
  UnboundCallerError,
} from '../service-bindings/index.js';

describe('Private Service-to-Service Bindings', () => {
  beforeEach(() => {
    ServiceBindingRuntime.reset();
    useContainer().clear();
  });

  it('declares exported operations on a service and allows authorized callers to invoke it', async () => {
    // 1. Declare target service
    @InjectableContainer()
    @ExportService({ name: 'inventory-service', operations: ['reserve', 'release'] })
    class InventoryService {
      public reservations: string[] = [];

      async reserve(items: string[]): Promise<{ reservationId: string }> {
        const id = `res-${items.length}`;
        this.reservations.push(id);
        return { reservationId: id };
      }

      async release(reservationId: string): Promise<void> {
        this.reservations = this.reservations.filter((id) => id !== reservationId);
      }
    }

    // 2. Declare caller service
    @InjectableContainer()
    class CheckoutService {
      constructor(
        @ServiceBinding('inventory', { caller: 'checkout-service', target: 'inventory-service' })
        public inventory: any,
      ) {}

      async checkout(items: string[]) {
        const result = await this.inventory.reserve(items);
        return result;
      }
    }

    // 3. Configure runtime with authorization grant
    const runtime = ServiceBindingRuntime.current;
    runtime.configure({
      currentServiceId: 'checkout-service',
      grants: [{ caller: 'checkout-service', target: 'inventory-service' }],
    });

    const checkout = useContainer().resolve(CheckoutService);
    const res = await checkout.checkout(['item-1', 'item-2']);
    expect(res).toEqual({ reservationId: 'res-2' });
  });

  it('rejects unbound callers without an explicit grant', async () => {
    @InjectableContainer()
    @ExportService({ name: 'inventory-service', operations: ['reserve'] })
    class InventoryService {
      async reserve(items: string[]) {
        return { count: items.length };
      }
    }

    @InjectableContainer()
    class RogueService {
      constructor(
        @ServiceBinding('inventory', { caller: 'rogue-service', target: 'inventory-service' })
        public inventory: any,
      ) {}

      async tryExploit() {
        return await this.inventory.reserve(['item-1']);
      }
    }

    // Note: No grant is given to rogue-service
    const rogue = useContainer().resolve(RogueService);

    let error: any;
    try {
      await rogue.tryExploit();
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(UnboundCallerError);
    expect(error.code).toBe('UNBOUND_CALLER');
    expect(error.caller).toBe('rogue-service');
    expect(error.target).toBe('inventory-service');
    expect(error.message).toContain("Unbound caller 'rogue-service'");
  });

  it('rejects calls to operations outside the authorized operations grant', async () => {
    @InjectableContainer()
    @ExportService({ name: 'inventory-service', operations: ['reserve', 'deleteInventory'] })
    class InventoryService {
      async reserve(items: string[]) {
        return { ok: true };
      }
      async deleteInventory() {
        return { deleted: true };
      }
    }

    @InjectableContainer()
    class LimitedCaller {
      constructor(
        @ServiceBinding('inventory', { caller: 'limited-caller', target: 'inventory-service' })
        public inventory: any,
      ) {}
    }

    // Grant permits ONLY 'reserve', not 'deleteInventory'
    const runtime = ServiceBindingRuntime.current;
    runtime.configure({
      grants: [
        {
          caller: 'limited-caller',
          target: 'inventory-service',
          allowedOperations: ['reserve'],
        },
      ],
    });

    const caller = useContainer().resolve(LimitedCaller);
    await expect(caller.inventory.reserve(['a'])).resolves.toEqual({ ok: true });
    await expect(caller.inventory.deleteInventory()).rejects.toThrow(UnauthorizedOperationError);
  });

  it('throws IncompatibleContractError when invoking an unexported operation', async () => {
    @InjectableContainer()
    @ExportService({ name: 'inventory-service', operations: ['reserve'] })
    class InventoryService {
      async reserve(items: string[]) {
        return { ok: true };
      }
    }

    @InjectableContainer()
    class Caller {
      constructor(
        @ServiceBinding('inventory', { caller: 'caller', target: 'inventory-service' })
        public inventory: any,
      ) {}
    }

    const runtime = ServiceBindingRuntime.current;
    runtime.configure({
      grants: [{ caller: 'caller', target: 'inventory-service' }],
    });

    const caller = useContainer().resolve(Caller);
    await expect(caller.inventory.nonExistentMethod()).rejects.toThrow(IncompatibleContractError);
  });

  it('throws TargetUnavailableError when target service is stopped or unregistered', async () => {
    @InjectableContainer()
    class Caller {
      constructor(
        @ServiceBinding('inventory', { caller: 'caller', target: 'down-service' })
        public inventory: any,
      ) {}
    }

    const runtime = ServiceBindingRuntime.current;
    runtime.configure({
      callers: {
        caller: {
          inventory: { target: 'down-service' },
        },
      },
      grants: [{ caller: 'caller', target: 'down-service' }],
    });

    const caller = useContainer().resolve(Caller);
    await expect(caller.inventory.reserve([])).rejects.toThrow(TargetUnavailableError);
  });

  it('throws MissingBindingError when named dependency is not configured', async () => {
    @InjectableContainer()
    class Caller {
      constructor(
        @ServiceBinding('unconfigured-binding', { caller: 'caller' })
        public dep: any,
      ) {}
    }

    const caller = useContainer().resolve(Caller);
    await expect(caller.dep.doSomething()).rejects.toThrow(MissingBindingError);
  });

  it('supports mock substitution for isolated testing without changing caller code', async () => {
    @InjectableContainer()
    class CheckoutService {
      @ServiceBinding('inventory', { caller: 'checkout' })
      public inventory!: { reserve(items: string[]): Promise<{ mockReservation: boolean }> };

      async processOrder() {
        return await this.inventory.reserve(['sku-100']);
      }
    }

    // Register a mock in the container directly
    const mockInventory = {
      reserve: async (items: string[]) => {
        return { mockReservation: true, itemsCount: items.length };
      },
    };

    useContainer().registerValue(serviceBindingToken('inventory'), mockInventory);

    const checkout = useContainer().resolve(CheckoutService);
    const res = await checkout.processOrder();
    expect(res).toEqual({ mockReservation: true, itemsCount: 1 } as any);
  });

  it('supports LocalServiceDevManager for multi-service dev, dynamic reload, and status reporting', async () => {
    const dev = new LocalServiceDevManager();

    class FakeInventory {
      async reserve(items: string[]) {
        return { v: 1, items };
      }
    }

    dev.registerService('inventory', new FakeInventory(), { operations: ['reserve'] });
    dev.bind('checkout', 'inventory', 'inventory');

    const status = dev.getStatus();
    expect(status.length).toBe(1);
    expect(status[0]?.status).toBe('CONNECTED');
    expect(status[0]?.target).toBe('inventory');

    const table = dev.formatStatusTable();
    expect(table).toContain('checkout');
    expect(table).toContain('inventory');
    expect(table).toContain('CONNECTED');

    // Test stopping service
    dev.stopService('inventory');
    expect(dev.getStatus()[0]?.status).toBe('UNAVAILABLE');

    // Test restarting
    dev.startService('inventory');
    expect(dev.getStatus()[0]?.status).toBe('CONNECTED');

    // Test reload with v2
    class FakeInventoryV2 {
      async reserve(items: string[]) {
        return { v: 2, items };
      }
    }
    dev.reloadService('inventory', new FakeInventoryV2(), { operations: ['reserve'] });

    const client = dev.runtime.invoke('checkout', 'inventory', 'reserve', [['apple']]);
    await expect(client).resolves.toEqual({ v: 2, items: ['apple'] });

    // Test revoking access to verify unbound caller diagnostics
    dev.revoke('checkout', 'inventory');
    expect(dev.getStatus()[0]?.status).toBe('UNBOUND');
    const diagnostics = dev.diagnose();
    expect(diagnostics.some((d) => d.code === 'UNBOUND_CALLER')).toBe(true);
  });
});

describe('Service binding review regressions', () => {
  beforeEach(() => {
    ServiceBindingRuntime.reset();
    useContainer().clear();
  });

  it('defers construction and invokes the container-managed instance with its dependencies', async () => {
    let constructions = 0;
    const dependency = { value: 42 };
    @ExportService({ name: 'lazy', requiresAuthorization: false })
    class LazyService {
      constructor(public dep: typeof dependency) {
        constructions++;
        if (!dep) throw new Error('Dependency required');
      }
      read() {
        return this.dep.value;
      }
    }
    expect(constructions).toBe(0);
    useContainer().registerFactory(LazyService, () => new LazyService(dependency));
    const runtime = ServiceBindingRuntime.current;
    expect(runtime.getStatus()).toEqual([]);
    expect(constructions).toBe(0);
    await expect(runtime.invoke('caller', 'lazy', 'read')).resolves.toBe(42);
    expect(runtime.registry.getService('lazy')!.instance).toBe(useContainer().resolve(LazyService));
    expect(constructions).toBe(1);
    expect(runtime.registry.getService('lazy')!.operations.has('constructor')).toBe(false);
  });

  it('removes mocks only from the requested caller scope', () => {
    const registry = ServiceBindingRuntime.current.registry;
    const global = { read: () => 'global' };
    const local = { read: () => 'local' };
    registry.registerMock('store', global);
    registry.registerMock('store', local, 'alice');
    registry.removeMock('store', 'unknown');
    expect(registry.getMock('store', 'bob')).toBe(global);
    registry.removeMock('store', 'alice');
    expect(registry.getMock('store', 'alice')).toBe(global);
    registry.registerMock('store', local, 'alice');
    registry.removeMock('store');
    expect(registry.getMock('store', 'bob')).toBeUndefined();
    expect(registry.getMock('store', 'alice')).toBe(local);
  });

  it('filters environment-loaded grants just like explicit configuration', () => {
    const previous = { env: process.env.DI_SERVICE_ENV, grants: process.env.DI_SERVICE_GRANTS };
    try {
      process.env.DI_SERVICE_ENV = 'test';
      const grants = [
        { caller: 'prod', target: 'store', environment: 'production' },
        { caller: 'test', target: 'store', environment: 'test' },
        { caller: 'shared', target: 'store' },
      ];
      process.env.DI_SERVICE_GRANTS = JSON.stringify(grants);
      const runtime = new ServiceBindingRuntime();
      expect(runtime.registry.getAllGrants()).toEqual(grants.slice(1));
      expect(runtime.registry.isCallerAuthorized('prod', 'store')).toBe(false);
    } finally {
      if (previous.env === undefined) delete process.env.DI_SERVICE_ENV;
      else process.env.DI_SERVICE_ENV = previous.env;
      if (previous.grants === undefined) delete process.env.DI_SERVICE_GRANTS;
      else process.env.DI_SERVICE_GRANTS = previous.grants;
    }
  });
});

it('supports binding proxy introspection, development mocks, and service removal', async () => {
  const { createServiceBindingClient, useServiceBindingRuntime } = await import(
    '../service-bindings/index.js'
  );
  const runtime = useServiceBindingRuntime();
  runtime.registry.clear();
  runtime.setCurrentServiceId('caller');
  runtime.setEnvironment('test');
  expect(runtime.getEnvironment()).toBe('test');
  runtime.setEnforceAuthorization(false);
  runtime.setEnforceAuthorizationOnMocks(true);
  const dev = new LocalServiceDevManager(runtime);
  expect(dev.formatStatusTable()).toBe('No active service bindings registered.');
  dev.bind('caller', 'store', 'store', { grantAccess: false });
  dev.substituteMock('store', { read: () => 42 });
  const client = createServiceBindingClient<any>('store');
  expect(client.$bindingMeta.caller).toBe('caller');
  expect(client[Symbol.iterator]).toBeUndefined();
  expect(client.toString()).toContain('caller->store');
  expect(client.then).toBeUndefined();
  expect('$bindingMeta' in client).toBe(true);
  expect('read' in client).toBe(true);
  await expect(client.read()).resolves.toBe(42);
  expect(dev.getStatus()[0]?.status).toBe('MOCKED');
  dev.clearMocks();
  dev.registerService('store', { read: () => 1 }, { operations: ['read'] });
  expect(runtime.registry.getAllServices()).toHaveLength(1);
  expect(runtime.registry.unregisterService('store')).toBe(true);
  expect(dev.diagnose()[0]?.code).toBe('TARGET_UNAVAILABLE');
  dev.reset();
  expect(dev.getStatus()).toEqual([]);
});

it('supports operation metadata and property binding fallback without container registration', async () => {
  const { ExportOperation } = await import('../decorators/ServiceBinding.js');
  const { getOwnMetadata } = await import('../container.js');
  class Target {
    read() {
      return 1;
    }
  }
  const descriptor = Object.getOwnPropertyDescriptor(Target.prototype, 'read')!;
  expect(ExportOperation()(Target.prototype, 'read', descriptor)).toBe(descriptor);
  expect(getOwnMetadata('di:export-operation', Target.prototype)).toEqual(['read']);
  class Caller {}
  ServiceBinding('fallback', { caller: 'fallback-caller' })(Caller.prototype, 'store');
  const originalResolve = useContainer().resolve;
  try {
    useContainer().resolve = () => {
      throw new Error('unavailable');
    };
    const caller = new Caller() as any;
    expect(caller.store.$bindingMeta.bindingName).toBe('fallback');
    expect(caller.store).toBe(caller.store);
    caller.store = { read: () => 9 };
    expect(caller.store.read()).toBe(9);
  } finally {
    useContainer().resolve = originalResolve;
  }
});

it('infers the caller and caches property clients resolved through the container', () => {
  class InferredCaller {}
  ServiceBinding('inferred')(InferredCaller.prototype, 'store');
  const caller = new InferredCaller() as any;
  expect(caller.store.$bindingMeta.caller).toBe('InferredCaller');
  expect(caller.store).toBe(caller.store);
  ServiceBinding('constructor-inferred')(InferredCaller, undefined, 0);
});

it('falls back when the property binding token resolves to an empty value', () => {
  class EmptyCaller {}
  ServiceBinding('empty')(EmptyCaller.prototype, 'store');
  useContainer().registerValue(serviceBindingToken('empty', 'EmptyCaller'), undefined);
  expect((new EmptyCaller() as any).store.$bindingMeta.bindingName).toBe('empty');
});
