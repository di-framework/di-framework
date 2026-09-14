import { WorkloadComponent } from '@di-framework/wasmcloud';
import { pallets } from './bindings';

export const fetch = WorkloadComponent({ path: '/take' })(async function fetch(
  request: Request,
): Promise<Response> {
  const url = new URL(request.url);
  const sku = url.searchParams.get('sku') ?? '';
  const qty = Number(url.searchParams.get('qty') ?? 0);
  if (!Number.isSafeInteger(qty) || qty < 0) {
    return Response.json(
      { ok: false, error: 'qty must be a nonnegative safe integer' },
      { status: 400 },
    );
  }
  const store = await pallets();
  const have = Number((await store.get(sku)) ?? 0);
  if (have < qty) return Response.json({ ok: false, have }, { status: 409 });
  await store.set(sku, String(have - qty));
  return Response.json({ ok: true, left: have - qty });
});

export default fetch;
