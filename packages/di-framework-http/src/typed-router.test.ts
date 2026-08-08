import { describe, expect, it } from 'bun:test';
import {
  json,
  type Multipart,
  type PathParams,
  type QueryParams,
  type RequestSpec,
  type ResponseSpec,
  TypedRouter,
} from './typed-router.ts';

describe('TypedRouter', () => {
  it('should handle GET requests', async () => {
    const router = TypedRouter();
    router.get('/test', () => json({ ok: true }));

    const req = new Request('http://localhost/test');
    const res = await router.fetch(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
  });

  it('should handle POST requests with JSON content-type', async () => {
    const router = TypedRouter();
    router.post('/test', (req) => json({ received: req.content }));

    const req = new Request('http://localhost/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hello: 'world' }),
    });
    const res = await router.fetch(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ received: { hello: 'world' } });
  });

  it('should reject POST requests without application/json', async () => {
    const router = TypedRouter();
    router.post('/test', () => json({ ok: true }));

    const req = new Request('http://localhost/test', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'hello',
    });
    const res = await router.fetch(req);
    expect(res.status).toBe(415);
    const body = (await res.json()) as any;
    expect(body.error).toBe('Content-Type must be application/json');
  });

  it('should attach path and method to the handler', () => {
    const router = TypedRouter();
    const handler = router.get('/metadata', () => json({}));

    expect(handler.path).toBe('/metadata');
    expect(handler.method).toBe('get');
  });

  it('should support extra arguments in fetch', async () => {
    type Env = { BINDING: string };
    const router = TypedRouter<[Env]>();
    router.get('/env', (_req, env) => json({ binding: env.BINDING }));

    const req = new Request('http://localhost/env');
    const res = await router.fetch(req, { BINDING: 'value' });
    const body = await res.json();
    expect(body).toEqual({ binding: 'value' });
  });

  it('should support other HTTP methods', async () => {
    const router = TypedRouter();
    router.put('/put', () => json({ method: 'PUT' }));
    router.delete('/delete', () => json({ method: 'DELETE' }));
    router.patch('/patch', () => json({ method: 'PATCH' }));

    expect(
      (
        (await (
          await router.fetch(
            new Request('http://localhost/put', {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: '{}',
            }),
          )
        ).json()) as any
      ).method,
    ).toBe('PUT');
    expect(
      (
        (await (
          await router.fetch(new Request('http://localhost/delete', { method: 'DELETE' }))
        ).json()) as any
      ).method,
    ).toBe('DELETE');
    expect(
      (
        (await (
          await router.fetch(
            new Request('http://localhost/patch', {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: '{}',
            }),
          )
        ).json()) as any
      ).method,
    ).toBe('PATCH');
  });

  it('should handle multipart POST requests with { multipart: true }', async () => {
    const router = TypedRouter();
    router.post<RequestSpec<Multipart<{ file: File }>>, ResponseSpec<{ ok: boolean }>>(
      '/upload',
      (req) => {
        return json({ ok: req.content instanceof FormData });
      },
      { multipart: true },
    );

    const formData = new FormData();
    formData.append('file', new Blob(['hello']), 'test.txt');

    const req = new Request('http://localhost/upload', {
      method: 'POST',
      body: formData,
    });
    const res = await router.fetch(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
  });

  it('should parse FormData as req.content in multipart handlers', async () => {
    const router = TypedRouter();
    router.post(
      '/upload',
      (req) => {
        const content = req.content as FormData;
        const name = content.get('name');
        return json({ name });
      },
      { multipart: true },
    );

    const formData = new FormData();
    formData.append('name', 'test-file');

    const req = new Request('http://localhost/upload', {
      method: 'POST',
      body: formData,
    });
    const res = await router.fetch(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.name).toBe('test-file');
  });

  it('should not enforce JSON content-type on multipart routes', async () => {
    const router = TypedRouter();
    router.post('/upload', () => json({ ok: true }), { multipart: true });

    const formData = new FormData();
    formData.append('field', 'value');

    const req = new Request('http://localhost/upload', {
      method: 'POST',
      body: formData,
    });
    const res = await router.fetch(req);
    const data = (await res.json()) as any;
    expect(data.ok).toBe(true);
  });

  it('should handle multipart post requests with malformed body gracefully', async () => {
    const router = TypedRouter();
    router.post(
      '/upload-bad',
      (req) => {
        return json({ content: req.content ?? null });
      },
      { multipart: true },
    );

    const req = new Request('http://localhost/upload-bad', {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=something' },
      body: 'bad boundary data',
    });

    const res = await router.fetch(req);
    const data = (await res.json()) as any;
    expect(data.content).toBeNull();
  });

  it('should still reject non-JSON on non-multipart POST routes (backward compat)', async () => {
    const router = TypedRouter();
    router.post('/json-only', () => json({ ok: true }));

    const formData = new FormData();
    formData.append('field', 'value');

    const req = new Request('http://localhost/json-only', {
      method: 'POST',
      body: formData,
    });
    const res = await router.fetch(req);
    expect(res.status).toBe(415);
  });

  it('should pass through non-function properties untouched', () => {
    const router = TypedRouter();
    router.get('/x', () => json({}));

    expect(Array.isArray((router as any).routes)).toBe(true);
    expect((router as any).routes.length).toBeGreaterThan(0);
  });

  it('should type params and query from RequestSpec', async () => {
    const router = TypedRouter();
    router.get<
      RequestSpec<PathParams<{ id: string }> & QueryParams<{ search?: string }>>,
      ResponseSpec<{ id: string; search?: string }>
    >('/item/:id', (req) => {
      // Type testing:
      const id: string = req.params.id;
      const search: string | undefined = req.query.search;
      return json({ id, search });
    });

    const req = new Request('http://localhost/item/123?search=test');
    const res = await router.fetch(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body).toEqual({ id: '123', search: 'test' });
  });
});
