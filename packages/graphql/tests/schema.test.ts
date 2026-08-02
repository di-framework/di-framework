import { describe, expect, it } from 'bun:test';
import { useContainer } from '@di-framework/di-framework/container';
import { buildSemanticSchema } from '../src/schema.ts';
import { printSDL } from '../src/sdl.ts';
import { buildTypeGraph } from '../src/type-graph.ts';
import { domainRegistry, type OrderRow, OrderService, OrderState } from './domain.ts';

const api = buildSemanticSchema({ registry: domainRegistry });

function run(query: string, context: Record<string, any> = { userId: 'u1' }, variables?: any) {
  return api.execute({ query, context, variables });
}

describe('semantic schema', () => {
  it('builds Query, Mutation and Subscription roots from portals', () => {
    expect(api.graph.query.fields.map((field) => field.name).sort()).toEqual([
      'me',
      'order',
      'user',
    ]);
    expect(api.graph.mutation?.fields.map((field) => field.name).sort()).toEqual([
      'orderCancel',
      'placeOrder',
    ]);
    expect(api.graph.subscription?.fields.map((field) => field.name)).toEqual(['orderPlaced']);
    expect(api.contexts).toEqual(['Orders', 'Users']);
  });

  it('exposes only what the decorators declare', () => {
    const user = api.graph.objects.find((object) => object.name === 'User');
    expect(user?.fields.map((field) => field.name).sort()).toEqual([
      'displayName',
      'email',
      'id',
      'name',
      'orders',
    ]);
  });

  it('prints SDL that matches the executable schema', async () => {
    const { buildSchema, lexicographicSortSchema, printSchema } = await import('graphql');
    const fromSdl = printSchema(lexicographicSortSchema(buildSchema(api.sdl)));
    const fromExecutable = printSchema(lexicographicSortSchema(api.schema));
    expect(fromSdl).toBe(fromExecutable);
  });

  it('emits semantic directives on request', () => {
    const sdl = printSDL(api.graph, { directives: true, descriptions: false });
    expect(sdl).toContain('type User @key(fields: "id") @context(name: "Users")');
    expect(sdl).toContain('directive @key(fields: String!) on OBJECT');
  });

  it('resolves through the DI container', async () => {
    const result = await run('{ user(id: "u1") { id name displayName } }');
    expect(result.errors).toBeUndefined();
    expect(result.data?.user).toEqual({
      id: 'u1',
      name: 'Ada Lovelace',
      displayName: 'Ada',
    });
  });

  it('passes the request context to conventionally named parameters', async () => {
    const result = await run('{ me { email } }', { userId: 'u2' });
    expect(result.data?.me).toEqual({ email: 'alan@example.com' });
  });

  it('hydrates plain repository rows onto the class so methods work', async () => {
    const result = await run('{ order(id: "o2") { state cancellable } }');
    expect(result.data?.order).toEqual({ state: 'Shipped', cancellable: false });
  });

  it('resolves a boundary extension declared by another context', async () => {
    const result = await run('{ user(id: "u1") { orders { id total } } }');
    expect(result.data?.user).toEqual({
      orders: [
        { id: 'o1', total: 42 },
        { id: 'o2', total: 7 },
      ],
    });
  });

  it('batches an extension field across parents resolved in the same tick', async () => {
    const orders = useContainer().resolve(OrderService);
    const before = orders.loads;

    const result = await run(`{
      first: user(id: "u1") { orders { id } }
      second: user(id: "u2") { orders { id } }
    }`);

    expect(result.errors).toBeUndefined();
    expect((result.data as any)?.first?.orders).toHaveLength(2);
    expect((result.data as any)?.second?.orders).toHaveLength(1);
    // One batched load for both users, instead of one per user.
    expect(orders.loads - before).toBe(1);
  });

  it('runs a portal action and hydrates input objects', async () => {
    const result = await run(
      `mutation Place($items: [OrderItemInput!]!) {
         placeOrder(items: $items) { id total state }
       }`,
      { userId: 'u1' },
      {
        items: [
          { sku: 'a', quantity: 2 },
          { sku: 'b', quantity: 3 },
        ],
      },
    );

    expect(result.errors).toBeUndefined();
    // lineTotal(10) is a method on OrderItemInput: 10 * (2 + 3).
    expect(result.data?.placeOrder).toMatchObject({ total: 50, state: 'Pending' });
  });

  it('routes an action declared on a type through its @Lookup', async () => {
    const result = await run(
      'mutation { orderCancel(id: "o3", reason: "changed my mind") { id state } }',
    );
    expect(result.errors).toBeUndefined();
    expect(result.data?.orderCancel).toEqual({ id: 'o3', state: 'Cancelled' });
  });

  it('lets the object reject an action that would break its invariant', async () => {
    const result = await run('mutation { orderCancel(id: "o2") { id } }');
    expect(result.errors?.[0]?.message).toContain('already shipped');
  });

  it('streams container events as subscriptions', async () => {
    const iterator = (await api.subscribe({
      query: 'subscription { orderPlaced { id state } }',
      context: { userId: 'u1' },
    })) as AsyncIterableIterator<any>;

    const next = iterator.next();
    useContainer()
      .resolve(OrderService)
      .place('u1', [{ sku: 'z', quantity: 1, lineTotal: (price: number) => price } as any]);

    const event = await next;
    expect(event.value.data.orderPlaced).toMatchObject({ state: OrderState.Pending });

    // Test iterator.throw()
    await expect(iterator.throw?.(new Error('sub err'))).rejects.toThrow('sub err');
  });

  it('slices the schema by bounded context', () => {
    const usersOnly = buildTypeGraph({ registry: domainRegistry, contexts: ['Users'] });
    expect(usersOnly.objects.map((object) => object.name)).toEqual(['User']);
    expect(usersOnly.query.fields.map((field) => field.name).sort()).toEqual(['me', 'user']);
    // The Orders extension of User is gone with its context.
    expect(usersOnly.objects[0]?.fields.map((field) => field.name)).not.toContain('orders');
  });

  it('constructs domain entity classes directly', () => {
    const { User, Order, OrderState, OrderService, UserOrders } =
      require('./domain.ts') as typeof import('./domain.ts');
    const user = new User('u9', 'Grace Hopper', 'grace@example.com');
    expect(user.displayName()).toBe('Grace');

    const order = new Order('o9', 'u9', 10, OrderState.Pending);
    expect(order.cancellable()).toBe(true);

    const orders = useContainer().resolve(OrderService);
    expect(orders.forUser('u1').length).toBeGreaterThan(0);

    const extension = useContainer().resolve(UserOrders);
    expect(extension.orders({ id: 'u1', name: 'Ada', email: 'a@b.c' }).length).toBeGreaterThan(0);
  });

  it('returns validation errors from subscribe without opening a stream', async () => {
    const result = await api.subscribe({ query: 'subscription { nope }' });
    expect(Symbol.asyncIterator in (result as any)).toBe(false);
    expect((result as any).errors?.length).toBeGreaterThan(0);
  });
});
