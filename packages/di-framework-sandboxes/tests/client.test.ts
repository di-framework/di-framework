import { describe, expect, test } from 'bun:test';
import { ControlClient, SandboxApiError } from '../index.ts';

function mockFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  return Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      if (input instanceof Request) {
        return handler(input.url, {
          method: input.method,
          body: input.body,
          headers: input.headers,
        });
      }
      const url = new URL(input.toString()).toString();
      return handler(url, init);
    },
    { preconnect: fetch.preconnect },
  );
}

describe('ControlClient', () => {
  test('uses generated routes and returns typed data', async () => {
    const client = new ControlClient({
      baseUrl: 'http://example.test/',
      fetch: mockFetch((url) => {
        expect(url).toBe('http://example.test/health');
        return Response.json({ status: 'ok' });
      }),
    });
    expect(await client.health()).toEqual({ status: 'ok' });
  });

  test('turns OpenAPI errors into SandboxApiError', async () => {
    const client = new ControlClient({
      fetch: mockFetch(() =>
        Response.json({ code: 'not_found', message: 'missing' }, { status: 404 }),
      ),
    });
    await expect(client.get('00000000-0000-0000-0000-000000000000')).rejects.toBeInstanceOf(
      SandboxApiError,
    );
  });

  test('create and sendSerial post to generated routes', async () => {
    const seen: string[] = [];
    const instance = {
      id: '11111111-1111-1111-1111-111111111111',
      name: 'box',
      status: 'starting' as const,
      memory_mib: 64,
      runtime: 'shell',
      created_at: '2026-01-01T00:00:00Z',
      last_error: null,
    };
    const client = new ControlClient({
      baseUrl: 'http://example.test',
      fetch: mockFetch((url, init) => {
        seen.push(`${init?.method ?? 'GET'} ${new URL(url).pathname}`);
        if (url.endsWith('/v1/instances') && init?.method === 'POST') {
          return Response.json(instance);
        }
        if (url.includes('/serial') && init?.method === 'POST') {
          return new Response(null, { status: 204 });
        }
        return Response.json({ error: 'unexpected' }, { status: 500 });
      }),
    });
    expect(await client.create({ name: 'box', memory_mib: 64, runtime: 'shell' })).toEqual(
      instance,
    );
    await client.sendSerial(instance.id, '\n');
    expect(seen).toEqual(['POST /v1/instances', `POST /v1/instances/${instance.id}/serial`]);
  });

  test('waitForStatus fails when the guest reports failed', async () => {
    const client = new ControlClient({
      fetch: mockFetch(() =>
        Response.json({
          id: '11111111-1111-1111-1111-111111111111',
          name: 'box',
          status: 'failed',
          memory_mib: 64,
          runtime: 'shell',
          created_at: '2026-01-01T00:00:00Z',
          last_error: 'boot failed',
        }),
      ),
    });
    await expect(
      client.waitForStatus('11111111-1111-1111-1111-111111111111', 'running'),
    ).rejects.toThrow('boot failed');
  });
});
