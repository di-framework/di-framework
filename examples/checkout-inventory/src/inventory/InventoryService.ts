import { Container } from '@di-framework/core/decorators';
import { ExportService } from '@di-framework/core/service-bindings';
import type {
  InventoryContract,
  ReleaseResult,
  ReservationItem,
  ReservationResult,
} from '../contracts/inventory';

/**
 * Inventory Service exports callable operations to bound callers.
 * It does not expose public HTTP routes or caller-addressable network endpoints.
 */
@Container()
@ExportService({
  name: 'inventory-service',
  version: '1.0.0',
  operations: ['reserve', 'release', 'checkStock'],
  description: 'Private inventory management service',
})
export class InventoryService implements InventoryContract {
  private stock = new Map<string, number>([
    ['laptop', 10],
    ['keyboard', 25],
    ['mouse', 40],
  ]);

  private reservations = new Map<string, ReservationItem[]>();

  async checkStock(sku: string): Promise<number> {
    return this.stock.get(sku) ?? 0;
  }

  async reserve(items: ReservationItem[]): Promise<ReservationResult> {
    // Verify all items have sufficient stock
    for (const item of items) {
      const current = this.stock.get(item.sku) ?? 0;
      if (current < item.quantity) {
        throw new Error(
          `Insufficient stock for SKU '${item.sku}': requested ${item.quantity}, available ${current}`,
        );
      }
    }

    // Deduct stock and record reservation
    for (const item of items) {
      const current = this.stock.get(item.sku) ?? 0;
      this.stock.set(item.sku, current - item.quantity);
    }

    const reservationId = `res_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    this.reservations.set(reservationId, items);

    return {
      reservationId,
      items,
      expiresAt: Date.now() + 15 * 60 * 1000,
    };
  }

  async release(reservationId: string): Promise<ReleaseResult> {
    const reservedItems = this.reservations.get(reservationId);
    if (!reservedItems) {
      return { released: false, reservationId };
    }

    // Return stock
    for (const item of reservedItems) {
      const current = this.stock.get(item.sku) ?? 0;
      this.stock.set(item.sku, current + item.quantity);
    }

    this.reservations.delete(reservationId);
    return { released: true, reservationId };
  }
}
