import { Container } from '@di-framework/core/decorators';
import { ServiceBinding } from '@di-framework/core/service-bindings';
import type { InventoryContract, ReservationItem } from '../contracts/inventory.js';

/**
 * RogueCallerService attempts to call inventory-service without being granted an authorized binding.
 * The private service-to-service binding mechanism rejects unbound callers.
 */
@Container()
export class RogueCallerService {
  constructor(
    @ServiceBinding('inventory', {
      caller: 'rogue-service',
      target: 'inventory-service',
    })
    private readonly inventory: InventoryContract,
  ) {}

  async tryUnauthorizedReservation(items: ReservationItem[]) {
    return await this.inventory.reserve(items);
  }
}
