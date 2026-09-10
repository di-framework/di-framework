import { Container } from '@di-framework/core/decorators';
import { ServiceBinding } from '@di-framework/core/service-bindings';
import type { InventoryContract, ReservationItem } from '../contracts/inventory';

export interface OrderRequest {
  orderId: string;
  items: ReservationItem[];
}

export interface OrderResult {
  orderId: string;
  status: 'confirmed' | 'cancelled';
  reservationId?: string;
  reason?: string;
}

/**
 * Checkout Service declares a named service dependency ('inventory') and invokes it through DI.
 * It does not need a URL or network address for the inventory service.
 */
@Container()
export class CheckoutService {
  constructor(
    @ServiceBinding('inventory', {
      caller: 'checkout-service',
      target: 'inventory-service',
      expectedOperations: ['reserve', 'release'],
    })
    private readonly inventory: InventoryContract,
  ) {}

  /**
   * Place an order by reserving inventory.
   */
  async placeOrder(order: OrderRequest): Promise<OrderResult> {
    try {
      const reservation = await this.inventory.reserve(order.items);
      return {
        orderId: order.orderId,
        status: 'confirmed',
        reservationId: reservation.reservationId,
      };
    } catch (err) {
      return {
        orderId: order.orderId,
        status: 'cancelled',
        reason: (err as Error).message,
      };
    }
  }

  /**
   * Cancel an order and release the reserved inventory.
   */
  async cancelOrder(orderId: string, reservationId: string): Promise<boolean> {
    const result = await this.inventory.release(reservationId);
    return result.released;
  }
}
