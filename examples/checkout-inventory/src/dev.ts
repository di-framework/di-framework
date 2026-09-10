import { useContainer } from '@di-framework/core/container';
import { LocalServiceDevManager, UnboundCallerError } from '@di-framework/core/service-bindings';
import { CheckoutService } from './checkout/CheckoutService';
import { InventoryService } from './inventory/InventoryService';
import { RogueCallerService } from './unbound/RogueCallerService';

export async function runLocalDev() {
  console.log('=== Starting Local Service Bindings Mesh ===\n');

  // 1. Initialize local multi-service dev coordinator
  const dev = new LocalServiceDevManager();

  // 2. Register local services
  dev.registerService('inventory-service', new InventoryService(), {
    operations: ['reserve', 'release', 'checkStock'],
    description: 'Local inventory service instance',
  });

  // 3. Grant and map binding: checkout -> inventory
  dev.bind('checkout-service', 'inventory', 'inventory-service', {
    allowedOperations: ['reserve', 'release', 'checkStock'],
    grantAccess: true,
  });

  // Note: rogue-service is configured to point to inventory-service, but NOT granted access
  dev.bind('rogue-service', 'inventory', 'inventory-service', {
    grantAccess: false,
  });

  // 4. Print binding status table
  console.log(dev.formatStatusTable());
  console.log();

  // 5. Test valid invocation from authorized CheckoutService
  const container = useContainer();
  const checkout = container.resolve(CheckoutService);

  console.log('Testing authorized call from CheckoutService...');
  const orderResult = await checkout.placeOrder({
    orderId: 'ord_101',
    items: [{ sku: 'laptop', quantity: 2 }],
  });
  console.log('Order result:', orderResult);

  // 6. Test rejection of unbound RogueCallerService
  console.log('\nTesting rejection of unbound RogueCallerService...');
  const rogue = container.resolve(RogueCallerService);
  try {
    await rogue.tryUnauthorizedReservation([{ sku: 'laptop', quantity: 1 }]);
    console.error('ERROR: Unbound caller was not rejected!');
  } catch (err) {
    if (err instanceof UnboundCallerError) {
      console.log('Successfully rejected unbound caller with UnboundCallerError:');
      console.log(`  Code: ${err.code}`);
      console.log(`  Message: ${err.message}`);
    } else {
      console.error('Unexpected error:', err);
    }
  }

  console.log('\n=== Local Service Bindings Mesh Completed Successfully ===');
}

if (import.meta.main) {
  runLocalDev().catch(console.error);
}
