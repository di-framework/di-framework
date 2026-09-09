import { beforeEach, describe, expect, it } from 'bun:test';
import { useContainer } from '../container.js';
import { Container as InjectableContainer } from '../decorators/Container.js';
import {
  ExportOperation,
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
