@WasmCloudBinding('orders-db', { config: { password: 'secret', database: 'orders' } })
export class OrdersDatabase extends Postgres {
  query() {
    return [];
  }
}

declare class Postgres {}
