import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { getWorkloadComponent, resetGuests, setGuests } from '@di-framework/wasmcloud';
import receiveFetch, { fetch as receiveNamed } from '@examples/warehouse-receive';
import { applyRemote, publishPeer, run, subscribe } from '@examples/warehouse-sync';
import takeFetch, { fetch as takeNamed } from '@examples/warehouse-take';
import { Sync } from '../packages/sync/src/bindings';

function memoryStock(initial: Record<string, string>) {
  const data = new Map<string, string>(Object.entries(initial));
  return {
    data,
    guest: {
      open: async () => ({
        get: async (key: string) => data.get(key) ?? null,
        set: async (key: string, value: string) => {
          data.set(key, value);
        },
      }),
    },
  };
}

/** Platform ingress: union of `route` claims. Not an application package. */
function implicitGateway(
  handlers: Array<(request: Request) => Promise<Response>>,
): (request: Request) => Promise<Response> {
  return async (request: Request) => {
    const path = new URL(request.url).pathname;
    for (const handler of handlers) {
      if (getWorkloadComponent(handler)?.route === path) return handler(request);
    }
    return new Response(null, { status: 404 });
  };
}

describe('warehouse namespace (independently deployed components)', () => {
  let stock: ReturnType<typeof memoryStock>;

  beforeEach(() => {
    resetGuests();
    stock = memoryStock({ 'pallet-a': '12', 'pallet-b': '4' });
    setGuests({ stock: stock.guest });
  });

  afterEach(() => resetGuests());

  it('takes and receives through separate packages against the same plugin', async () => {
    const taken = await takeFetch(
      new Request('http://warehouse/take?sku=pallet-a&qty=2', { method: 'POST' }),
    );
    expect(taken.status).toBe(200);
    expect(await taken.json()).toEqual({ ok: true, left: 10 });

    const received = await receiveFetch(
      new Request('http://warehouse/receive?sku=pallet-a&qty=3', { method: 'POST' }),
    );
    expect(await received.json()).toEqual({ ok: true, qty: 13 });
  });

  it('implies HTTP ingress from component route claims', async () => {
    expect(takeFetch).toBe(takeNamed);
    expect(receiveFetch).toBe(receiveNamed);
    expect(getWorkloadComponent(takeFetch)).toEqual({
      workload: 'warehouse',
      route: '/take',
    });
    expect(getWorkloadComponent(receiveFetch)).toEqual({
      workload: 'warehouse',
      route: '/receive',
    });

    const gateway = implicitGateway([takeFetch, receiveFetch]);
    const res = await gateway(
      new Request('http://warehouse/take?sku=pallet-b&qty=4', { method: 'POST' }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, left: 0 });

    const missing = await gateway(new Request('http://warehouse/nope'));
    expect(missing.status).toBe(404);
  });

  it('rejects take when the plugin is short', async () => {
    const res = await takeFetch(
      new Request('http://warehouse/take?sku=pallet-b&qty=9', { method: 'POST' }),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ ok: false, have: 4 });
  });

  it('applies peer stock through the service without calling a component', async () => {
    await applyRemote({ sku: 'pallet-a', qty: 99 });
    expect(stock.data.get('pallet-a')).toBe('99');
  });
  it('queues peer events and closes subscriptions', async () => {
    const stream = subscribe(new Sync(), 'warehouse.stock')[Symbol.asyncIterator]();
    const first = stream.next();
    publishPeer({ sku: 'pallet-a', qty: 20 });
    publishPeer({ sku: 'pallet-b', qty: 30 });
    expect(await first).toEqual({ done: false, value: { sku: 'pallet-a', qty: 20 } });
    expect(await stream.next()).toEqual({ done: false, value: { sku: 'pallet-b', qty: 30 } });
    await stream.return?.();
    publishPeer({ sku: 'pallet-a', qty: 99 });
    expect((await stream.next()).done).toBe(true);
  });

  it('runs the sync service and closes its subscription on a storage failure', async () => {
    const applied = Promise.withResolvers<void>();
    setGuests({
      stock: {
        open: async () => ({
          set: async (sku: string, qty: string) => {
            if (sku === 'unavailable') throw new Error('stock unavailable');
            stock.data.set(sku, qty);
            applied.resolve();
          },
        }),
      },
    });
    const running = run().catch((error: unknown) => error);
    publishPeer({ sku: 'pallet-a', qty: 42 });
    await applied.promise;
    expect(stock.data.get('pallet-a')).toBe('42');
    publishPeer({ sku: 'unavailable', qty: 1 });
    expect(await running).toMatchObject({ message: 'stock unavailable' });
  });

  it('finishes when the peer event stream ends and applies updates in order', async () => {
    async function* events() {
      yield { sku: 'pallet-a', qty: 20 };
      yield { sku: 'pallet-a', qty: 30 };
    }
    await run(events());
    expect(stock.data.get('pallet-a')).toBe('30');
  });
});
