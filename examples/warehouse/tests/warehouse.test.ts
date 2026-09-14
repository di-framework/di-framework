import { beforeEach, describe, expect, it } from 'bun:test';
import { getWorkloadComponent, resetGuests, setGuests } from '@di-framework/wasmcloud';
import receiveFetch, { fetch as receiveNamed } from '@examples/warehouse-receive';
import { applyRemote, handleMessage } from '@examples/warehouse-sync';
import takeFetch, { fetch as takeNamed } from '@examples/warehouse-take';
import { pallets as syncPallets } from '../packages/sync/src/bindings';

function memoryStock(initial: Record<string, string>) {
  const data = new Map<string, string>(Object.entries(initial));
  return {
    data,
    guest: {
      open: async () => ({
        get: async (key: string) => ({
          tag: 'ok',
          val: data.has(key) ? new TextEncoder().encode(data.get(key)) : undefined,
        }),
        set: async (key: string, value: Uint8Array, options: undefined) => {
          expect(value).toBeInstanceOf(Uint8Array);
          expect(options).toBeUndefined();
          data.set(key, new TextDecoder().decode(value));
          return { tag: 'ok', val: undefined };
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
      if (getWorkloadComponent(handler)?.path === path) return handler(request);
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

  for (const [name, handler] of [
    ['take', takeFetch],
    ['receive', receiveFetch],
  ] as const) {
    it(`${name} rejects invalid quantities without changing stock`, async () => {
      for (const qty of ['abc', 'NaN', 'Infinity', '-1', '1.5', '9007199254740992']) {
        const res = await handler(
          new Request(`http://warehouse/${name}?sku=pallet-a&qty=${qty}`, { method: 'POST' }),
        );
        expect(res.status).toBe(400);
        expect(stock.data.get('pallet-a')).toBe('12');
      }
    });

    it(`${name} accepts zero without changing stock`, async () => {
      const res = await handler(new Request(`http://warehouse/${name}?sku=pallet-a&qty=0`));
      expect(res.status).toBe(200);
      expect(stock.data.get('pallet-a')).toBe('12');
    });
  }

  it('records HTTP routes on component declarations', async () => {
    expect(takeFetch).toBe(takeNamed);
    expect(receiveFetch).toBe(receiveNamed);
    expect(getWorkloadComponent(takeFetch)).toEqual({
      path: '/take',
    });
    expect(getWorkloadComponent(receiveFetch)).toEqual({
      path: '/receive',
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

  it('consumes a streamed broker delivery and replies after storing it', async () => {
    const replies: unknown[] = [];
    setGuests({
      stock: stock.guest,
      sync: {
        publish: async (message: { subject: string; body: AsyncIterable<Uint8Array> }) => {
          const chunks: number[] = [];
          for await (const chunk of message.body) chunks.push(...chunk);
          replies.push({
            subject: message.subject,
            body: JSON.parse(new TextDecoder().decode(new Uint8Array(chunks))),
          });
        },
      },
    });
    async function* body() {
      yield new TextEncoder().encode('{"sku":"pallet-a","qty":37}');
    }
    await handleMessage({ subject: 'warehouse.stock', body: body(), replyTo: 'test.reply' });
    expect(stock.data.get('pallet-a')).toBe('37');
    expect(replies).toHaveLength(1);
    expect(replies[0]).toEqual({
      subject: 'test.reply',
      body: { ok: true, sku: 'pallet-a', qty: 37 },
    });
  });

  it('reads native keyvalue bytes through the sync binding', async () => {
    const store = await syncPallets();
    expect(await store.get('pallet-a')).toBe('12');
    expect(await store.get('missing')).toBeNull();
  });

  it('requests retry when acknowledgement publishing fails after the stock write', async () => {
    setGuests({
      stock: stock.guest,
      sync: { publish: async () => ({ tag: 'err', val: 'unavailable' }) },
    });
    async function* body() {
      yield new TextEncoder().encode('{"sku":"pallet-a","qty":9}');
    }
    await expect(
      handleMessage({ subject: 'warehouse.stock', body: body(), replyTo: 'test.reply' }),
    ).rejects.toEqual({ tag: 'retry' });
    expect(stock.data.get('pallet-a')).toBe('9');
  });

  it('rejects malformed peer stock without changing storage', async () => {
    async function* body() {
      yield new TextEncoder().encode('{"sku":"pallet-a","qty":-1}');
    }
    await expect(handleMessage({ subject: 'warehouse.stock', body: body() })).rejects.toEqual({
      tag: 'reject',
    });
    expect(stock.data.get('pallet-a')).toBe('12');
  });

  it('propagates storage errors instead of treating them as empty stock', async () => {
    setGuests({
      stock: {
        open: async () => ({ get: async () => ({ tag: 'err', val: 'store-unavailable' }) }),
      },
    });
    await expect(
      takeFetch(new Request('http://warehouse/take?sku=pallet-a&qty=1')),
    ).rejects.toThrow('store-unavailable');
  });
});
