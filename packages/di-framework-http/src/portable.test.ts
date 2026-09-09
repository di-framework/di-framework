import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packageStaticAssets } from '../index.ts';
import { createBufferStream, HttpRouter, registerStaticAssets } from '../portable.ts';

test('portable entry serves packaged bytes and metadata without importing filesystem utilities', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'http-portable-'));
  try {
    await Bun.write(join(directory, 'hello.txt'), 'hello');
    await Bun.write(join(directory, 'image.png'), new Uint8Array([0, 255, 128, 10]));
    const pkg = packageStaticAssets({ directory });
    rmSync(directory, { recursive: true });
    registerStaticAssets('/portable', pkg);
    const router = HttpRouter.builder()
      .static('/portable', { directory, cacheControl: 'public, max-age=60' })
      .build();
    const request = (path: string, init?: RequestInit) =>
      router.fetch(new Request(`http://localhost/portable/${path}`, init));
    const text = await request('hello.txt');
    expect(await text.text()).toBe('hello');
    expect(text.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(text.headers.get('cache-control')).toBe('public, max-age=60');
    expect(
      (await request('hello.txt', { headers: { 'if-none-match': text.headers.get('etag')! } }))
        .status,
    ).toBe(304);
    const head = await request('image.png', { method: 'HEAD' });
    expect(head.headers.get('content-length')).toBe('4');
    expect(await head.text()).toBe('');
    expect(new Uint8Array(await (await request('image.png')).arrayBuffer())).toEqual(
      new Uint8Array([0, 255, 128, 10]),
    );
    expect((await request('missing')).status).toBe(404);
    expect((await request('%2e%2e%2fsecret')).status).toBe(403);
    const built = await Bun.build({
      entrypoints: [join(import.meta.dir, '../portable.ts')],
      target: 'node',
      packages: 'external',
    });
    expect(built.success).toBe(true);
    const output = await built.outputs[0]!.text();
    expect(output).not.toContain('node:fs');
    expect(output).not.toContain('node:stream');
    expect(output).not.toContain('packageStaticAssets');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('packaged responses do not require a global ReadableStream constructor', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'ReadableStream');
  try {
    Reflect.deleteProperty(globalThis, 'ReadableStream');
    const router = HttpRouter.builder()
      .static('/bytes', {
        directory: '/not-mounted',
        package: {
          version: 1,
          generatedAt: '',
          assets: {
            '/data.bin': {
              path: '/data.bin',
              contentType: 'application/octet-stream',
              size: 3,
              hash: 'hash',
              etag: '"hash"',
              encoding: 'base64',
              content: 'AP+A',
            },
          },
        },
      })
      .build();
    const response = await router.fetch(new Request('http://localhost/bytes/data.bin'));
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([0, 255, 128]));
  } finally {
    if (original) Object.defineProperty(globalThis, 'ReadableStream', original);
  }
});

test('the existing buffer-stream helper preserves bytes across chunks and handles empty input', async () => {
  const data = new Uint8Array([0, 255, 128, 42, 1]);
  expect(new Uint8Array(await new Response(createBufferStream(data, 2)).arrayBuffer())).toEqual(
    data,
  );
  expect(await new Response(createBufferStream(new Uint8Array())).text()).toBe('');
});
