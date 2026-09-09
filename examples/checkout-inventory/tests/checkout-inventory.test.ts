import { beforeEach, describe, expect, it } from 'bun:test';
import { useContainer } from '@di-framework/core/container';
import {
  LocalServiceDevManager,
  ServiceBindingRuntime,
  serviceBindingToken,
  TargetUnavailableError,
  UnboundCallerError,
} from '@di-framework/core/service-bindings';
import { CheckoutService } from '../src/checkout/CheckoutService.js';
import { InventoryService } from '../src/inventory/InventoryService.js';
import { RogueCallerService } from '../src/unbound/RogueCallerService.js';

describe('Checkout / Inventory Service Bindings Example', () => {
  let dev: LocalServiceDevManager;

  beforeEach(() => {
    ServiceBindingRuntime.reset();
    useContainer().clear();
    useContainer().register(CheckoutService);
    useContainer().register(RogueCallerService);

    dev = new LocalServiceDevManager();
    dev.registerService('inventory-service', new InventoryService(), {
      operations: ['reserve', 'release', 'checkStock'],
    });

    // Grant checkout-service access to inventory-service
    dev.bind('checkout-service', 'inventory', 'inventory-service', {
      allowedOperations: ['reserve', 'release', 'checkStock'],
      grantAccess: true,
    });

    // Configure rogue-service without an authorized grant
    dev.bind('rogue-service', 'inventory', 'inventory-service', {
      grantAccess: false,
    });
  });

  it('demonstrates checkout calling inventory through a private binding', async () => {
    const checkout = useContainer().resolve(CheckoutService);

    // 1. Place order for in-stock items
    const order = await checkout.placeOrder({
      orderId: 'order_1',
      items: [{ sku: 'laptop', quantity: 2 }],
    });

    expect(order.status).toBe('confirmed');
    expect(order.orderId).toBe('order_1');
    expect(typeof order.reservationId).toBe('string');

    // 2. Cancel order and release reservation
    const released = await checkout.cancelOrder('order_1', order.reservationId!);
    expect(released).toBe(true);
  });

  it('rejects an unbound caller without authorized access', async () => {
    const rogue = useContainer().resolve(RogueCallerService);

    let thrownError: any;
    try {
      await rogue.tryUnauthorizedReservation([{ sku: 'mouse', quantity: 1 }]);
    } catch (err) {
      thrownError = err;
    }

    expect(thrownError).toBeInstanceOf(UnboundCallerError);
    expect(thrownError.code).toBe('UNBOUND_CALLER');
    expect(thrownError.caller).toBe('rogue-service');
    expect(thrownError.target).toBe('inventory-service');
    expect(thrownError.message).toContain("Unbound caller 'rogue-service'");
  });

  it('supports substituting a bound service with a mock for isolated unit testing', async () => {
    // Substitute mock via DI container
    const mockCalls: string[] = [];
    const fakeInventory = {
      reserve: async (items: any[]) => {
        mockCalls.push(`reserved:${items.length}`);
        return {
          reservationId: 'mock-res-42',
          items,
          expiresAt: Date.now() + 60000,
        };
      },
      release: async (id: string) => {
        mockCalls.push(`released:${id}`);
        return { released: true, reservationId: id };
      },
      checkStock: async () => 999,
    };

    useContainer().registerValue(serviceBindingToken('inventory'), fakeInventory);

    const checkout = useContainer().resolve(CheckoutService);
    const order = await checkout.placeOrder({
      orderId: 'isolated_test_1',
      items: [{ sku: 'keyboard', quantity: 3 }],
    });

    expect(order.status).toBe('confirmed');
    expect(order.reservationId).toBe('mock-res-42');
    expect(mockCalls).toContain('reserved:1');

    const released = await checkout.cancelOrder('isolated_test_1', 'mock-res-42');
    expect(released).toBe(true);
    expect(mockCalls).toContain('released:mock-res-42');
  });

  it('handles target service shutdown and restart in local development', async () => {
    const checkout = useContainer().resolve(CheckoutService);

    // Stop target service
    dev.stopService('inventory-service');

    const orderFailed = await checkout.placeOrder({
      orderId: 'order_offline',
      items: [{ sku: 'laptop', quantity: 1 }],
    });
    expect(orderFailed.status).toBe('cancelled');
    expect(orderFailed.reason).toContain('unavailable');

    // Restart target service
    dev.startService('inventory-service');

    const orderSuccess = await checkout.placeOrder({
      orderId: 'order_online',
      items: [{ sku: 'laptop', quantity: 1 }],
    });
    expect(orderSuccess.status).toBe('confirmed');
  });

  it('reports binding status and diagnostics', () => {
    const status = dev.getStatus();
    expect(status.length).toBe(2);

    const checkoutStatus = status.find((s) => s.caller === 'checkout-service');
    expect(checkoutStatus?.status).toBe('CONNECTED');
    expect(checkoutStatus?.exportedOperations).toContain('reserve');

    const rogueStatus = status.find((s) => s.caller === 'rogue-service');
    expect(rogueStatus?.status).toBe('UNBOUND');

    const diagnostics = dev.diagnose();
    expect(
      diagnostics.some((d) => d.code === 'UNBOUND_CALLER' && d.caller === 'rogue-service'),
    ).toBe(true);

    const table = dev.formatStatusTable();
    expect(table).toContain('checkout-service');
    expect(table).toContain('rogue-service');
    expect(table).toContain('UNBOUND');
  });
});
