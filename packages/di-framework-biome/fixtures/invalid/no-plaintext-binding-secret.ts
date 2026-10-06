declare class Postgres {}

@WasmCloudBinding('orders-db', { config: { password: 'secret', database: 'orders' } })
export class OrdersDatabase extends Postgres {
  query() {
    return [];
  }
}
