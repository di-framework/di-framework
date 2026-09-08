import { afterEach, describe, expect, it, mock } from 'bun:test';
import { createHash as nodeCreateHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_DEPS } from '../src/deps';
import { getRandomBytes, resetMemoryRandom } from './memory-wasi-random';
import {
  nameRecords,
  resetMemorySockets,
  resolveAddresses,
  TcpSocket,
  UdpSocket,
} from './memory-wasi-sockets';

mock.module('wasi:sockets/types@0.3.0', () => ({ TcpSocket, UdpSocket }));
mock.module('wasi:sockets/ip-name-lookup@0.3.0', () => ({ resolveAddresses }));
mock.module('wasi:random/random@0.3.0', () => ({ getRandomBytes }));

const { createConnection, createServer: createNetServer } = await import('../src/node-compat/net');
const { createServer, get, request, STATUS_CODES } = await import('../src/node-compat/http');

afterEach(() => {
  resetMemorySockets();
  resetMemoryRandom();
  nameRecords.clear();
});

describe('node:http overlay', () => {
  it('serves GET and POST over the TCP overlay and reports address() after listen', async () => {
    const server = createServer((req, res) => {
      if (req.method === 'GET') {
        res.statusCode = 200;
        res.end('hello');
        return;
      }
      const chunks: Uint8Array[] = [];
      req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      req.on('end', () => {
        res.statusCode = 200;
        res.end(Buffer.concat(chunks));
      });
    });
    server.listen(0, '127.0.0.1');
    const info = server.address();
    expect(info).not.toBeNull();
    const port = info?.port ?? 0;
    expect(port).toBeGreaterThan(0);

    const getBody = await new Promise<string>((resolve, reject) => {
      const req = get({ host: '127.0.0.1', port, path: '/' }, (res) => {
        const chunks: Uint8Array[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        res.on('end', () => resolve(Buffer.concat(chunks).toString()));
      });
      req.once('error', reject);
    });
    expect(getBody).toBe('hello');

    const postBody = await new Promise<string>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: '/', method: 'POST' }, (res) => {
        const chunks: Uint8Array[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        res.on('end', () => resolve(Buffer.concat(chunks).toString()));
      });
      req.once('error', reject);
      req.end('payload');
    });
    expect(postBody).toBe('payload');
    expect(STATUS_CODES[426]).toBe('Upgrade Required');
    server.close();
  });

  it('emits upgrade with leftover head bytes', async () => {
    const server = createServer((_req, res) => {
      res.statusCode = 404;
      res.end('Not found');
    });
    server.listen(0, '127.0.0.1');
    const port = server.address()?.port ?? 0;
    const upgraded = new Promise<{ url: string; head: string }>((resolve) => {
      server.on('upgrade', (req, socket, head) => {
        resolve({ url: req.url, head: Buffer.from(head).toString() });
        socket.end();
      });
    });
    const client = createConnection({ host: '127.0.0.1', port });
    await new Promise<void>((resolve, reject) => {
      client.once('connect', () => resolve());
      client.once('error', reject);
    });
    client.write(
      'GET /chat HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\nextra',
    );
    expect(await upgraded).toEqual({ url: '/chat', head: 'extra' });
    server.close();
  });

  it('parses a 101 upgrade response on http.request', async () => {
    const raw = createNetServer((socket) => {
      socket.on('data', () => {
        socket.write(
          'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\nleftover',
        );
      });
    });
    raw.listen(0, '127.0.0.1');
    const port = raw.address()?.port ?? 0;
    const upgraded = await new Promise<{ status: number; head: string }>((resolve, reject) => {
      const req = request({
        host: '127.0.0.1',
        port,
        path: '/',
        headers: { Upgrade: 'websocket', Connection: 'Upgrade' },
      });
      req.on('upgrade', (res, _socket, head) => {
        resolve({ status: res.statusCode, head: Buffer.from(head).toString() });
      });
      req.once('error', reject);
      req.end();
    });
    expect(upgraded).toEqual({ status: 101, head: 'leftover' });
    raw.close();
  });
});

describe('bundled node:http overlay', () => {
  it('keeps wasi:sockets imports external and echoes HTTP in the guest bundle', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wasmcloud-http-bundle-'));
    const adapterPath = join(root, 'adapter.ts');
    const entryPath = join(root, 'entry.ts');
    const outFile = join(root, 'out', 'component.js');
    writeFileSync(
      adapterPath,
      "import application from 'virtual:di-framework-application';\nexport const handler = application;\n",
    );
    writeFileSync(
      entryPath,
      `
import { createServer, get } from 'node:http';

export default async function echo(): Promise<string> {
  const server = createServer((_req, res) => {
    res.statusCode = 200;
    res.end('ok');
  });
  server.listen(0, '127.0.0.1');
  const port = server.address()?.port ?? 0;
  const body = await new Promise<string>((resolve, reject) => {
    const req = get({ host: '127.0.0.1', port, path: '/' }, (res) => {
      const chunks: Uint8Array[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => resolve(Buffer.concat(chunks).toString()));
    });
    req.once('error', reject);
  });
  server.close();
  return body;
}
`,
    );
    await DEFAULT_DEPS.bundler({ adapterPath, entryPath, outFile });
    const source = await Bun.file(outFile).text();
    expect(source).toContain('wasi:sockets/types@0.3.0');
    expect(source).not.toContain('wasi:random/random@0.3.0');
    const bundled = await import(pathToFileURL(outFile).href);
    expect(await bundled.handler()).toBe('ok');
  });

  it('bundles a WebSocket accept-key handshake over node:http', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wasmcloud-ws-http-bundle-'));
    const adapterPath = join(root, 'adapter.ts');
    const entryPath = join(root, 'entry.ts');
    const outFile = join(root, 'out', 'component.js');
    writeFileSync(
      adapterPath,
      "import application from 'virtual:di-framework-application';\nexport const handler = application;\n",
    );
    writeFileSync(
      entryPath,
      `
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export default async function handshake(): Promise<string> {
  const server = createServer((_req, res) => {
    res.statusCode = 404;
    res.end('Not found');
  });
  server.on('upgrade', (req, socket) => {
    const key = String(req.headers['sec-websocket-key'] ?? '');
    const accept = createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: ' +
        accept +
        '\\r\\n\\r\\n',
    );
    socket.end();
  });
  server.listen(0, '127.0.0.1');
  const port = server.address()?.port ?? 0;
  const client = createConnection({ host: '127.0.0.1', port });
  const response = await new Promise<string>((resolve, reject) => {
    client.once('connect', () => {
      client.write(
        'GET / HTTP/1.1\\r\\nHost: localhost\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\\r\\n\\r\\n',
      );
    });
    client.on('data', (chunk) => resolve(Buffer.from(chunk).toString()));
    client.once('error', reject);
  });
  server.close();
  return response;
}
`,
    );
    await DEFAULT_DEPS.bundler({ adapterPath, entryPath, outFile });
    const source = await Bun.file(outFile).text();
    expect(source).toContain('wasi:sockets/types@0.3.0');
    const bundled = await import(pathToFileURL(outFile).href);
    const response = await bundled.handler();
    expect(response).toContain('101 Switching Protocols');
    expect(response).toContain(
      `Sec-WebSocket-Accept: ${nodeCreateHash('sha1').update('dGhlIHNhbXBsZSBub25jZQ==258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')}`,
    );
  });
});
