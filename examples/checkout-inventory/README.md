# Checkout & Inventory Private Service Bindings Example

This example demonstrates **private service-to-service bindings** in `@di-framework`.

It illustrates how independently deployable services can communicate privately without publishing public HTTP routes, ingress endpoints, or caller-addressable URLs.

## Features Demonstrated

1. **Declared Exported Operations**:
   The `InventoryService` exposes `reserve(items)`, `release(reservationId)`, and `checkStock(sku)` using `@ExportService`:
   ```ts
   @Container()
   @ExportService({
     name: 'inventory-service',
     operations: ['reserve', 'release', 'checkStock'],
   })
   export class InventoryService implements InventoryContract { ... }
   ```

2. **Named Dependency Injection**:
   The `CheckoutService` injects the `inventory` binding using `@ServiceBinding`:
   ```ts
   @Container()
   export class CheckoutService {
     constructor(
       @ServiceBinding('inventory', {
         caller: 'checkout-service',
         target: 'inventory-service',
       })
       private readonly inventory: InventoryContract,
     ) {}
   }
   ```

3. **Rejection of Unbound Callers**:
   Services without an explicit grant (such as `RogueCallerService`) cannot invoke target services. Invocations are rejected with an actionable `UnboundCallerError`.

4. **Local Multi-Service Development**:
   `LocalServiceDevManager` connects and manages local services without deployment:
   - Discovers and connects local services
   - Reports live binding status and contract compatibility
   - Handles target service startup, shutdown, and hot reload

5. **Mock Substitution in Tests**:
   Callers can be unit-tested in isolation by substituting a mock through the DI container (`container.registerValue(serviceBindingToken('inventory'), mock)`) or `LocalServiceDevManager`, without changing application code.

## Project Structure

- `src/contracts/inventory.ts`: The contract interface for the inventory service.
- `src/inventory/InventoryService.ts`: Concrete service declaring exported operations.
- `src/checkout/CheckoutService.ts`: Consumer injecting the named binding.
- `src/unbound/RogueCallerService.ts`: Unbound service demonstrating rejection.
- `src/dev.ts`: Local multi-service development coordinator.
- `tests/checkout-inventory.test.ts`: Automated test suite.

## Running Locally

Run the local multi-service mesh:
```bash
bun run dev
```

Run tests:
```bash
bun test
```
