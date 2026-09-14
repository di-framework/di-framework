import { deepStrictEqual } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';

// Use loopback port-forwards to the tenant HTTP and data-NATS Services.
const http = process.env.WAREHOUSE_HTTP_URL ?? 'http://127.0.0.1:28182';
const nats = new URL(process.env.WAREHOUSE_NATS_URL ?? 'nats://127.0.0.1:24222');
if (nats.protocol !== 'nats:')
  throw new Error('Smoke testing expects a plain data-NATS port-forward');
const sku = `smoke-${randomUUID()}`;

async function stock(
  member: 'receive' | 'take',
  quantity: number,
  status: number,
  expected: object,
) {
  const url = new URL(`/${member}`, http);
  url.searchParams.set('sku', sku);
  url.searchParams.set('qty', String(quantity));
  const response = await fetch(url, {
    method: 'POST',
    headers: { Host: `warehouse-${member}` },
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.text();
  if (response.status !== status) throw new Error(`${member}: HTTP ${response.status}: ${body}`);
  deepStrictEqual(JSON.parse(body), expected);
  console.log(`PASS ${member} ${quantity}: ${body}`);
}

// Minimal NATS request/reply probe. It uses the actual broker and the deployed sync
// handler, and waits for its acknowledgement after the Redis write has completed.
async function sync(quantity: number): Promise<void> {
  const expected = { ok: true, sku, qty: quantity };
  const reply = `_INBOX.warehouse.${randomUUID().replaceAll('-', '')}`;
  const payload = JSON.stringify({ sku, qty: quantity });
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection({ host: nats.hostname, port: Number(nats.port || 4222) });
    let buffer = Buffer.alloc(0);
    let started = false;
    let complete = false;
    const timer = setTimeout(
      () => finish(new Error('Timed out waiting for deployed warehouse-sync acknowledgement')),
      15_000,
    );
    function finish(error?: Error) {
      if (complete) return;
      complete = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve();
    }
    socket.on('error', finish);
    socket.on('close', () => {
      if (!complete) finish(new Error('NATS disconnected before acknowledgement'));
    });
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, typeof chunk === 'string' ? Buffer.from(chunk) : chunk]);
      try {
        while (true) {
          const end = buffer.indexOf('\r\n');
          if (end < 0) return;
          const line = buffer.subarray(0, end).toString();
          if (line.startsWith('MSG ')) {
            const fields = line.split(' ');
            const length = Number(fields.at(-1));
            if (!Number.isSafeInteger(length) || length < 0)
              throw new Error('Invalid NATS payload length');
            if (buffer.length < end + 2 + length + 2) return;
            if (fields[1] !== reply) throw new Error('Unexpected NATS reply subject');
            deepStrictEqual(
              JSON.parse(buffer.subarray(end + 2, end + 2 + length).toString()),
              expected,
            );
            finish();
            return;
          }
          buffer = buffer.subarray(end + 2);
          if (line.startsWith('-ERR')) throw new Error(line);
          if (line === 'PING') socket.write('PONG\r\n');
          if (line.startsWith('INFO ') && !started) {
            const info = JSON.parse(line.slice(5));
            if (info.tls_required || info.auth_required)
              throw new Error(
                'Use the tenant data-NATS Service; this probe does not use scheduler credentials',
              );
            started = true;
            socket.write(
              `CONNECT {"verbose":false,"pedantic":true}\r\nSUB ${reply} 1\r\nUNSUB 1 1\r\nPUB warehouse.stock ${reply} ${Buffer.byteLength(payload)}\r\n${payload}\r\nPING\r\n`,
            );
          }
        }
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
  console.log(`PASS NATS sync: ${JSON.stringify(expected)}`);
}

await stock('receive', 3, 200, { ok: true, qty: 3 });
await stock('take', 2, 200, { ok: true, left: 1 });
await stock('take', 2, 409, { ok: false, have: 1 });
await sync(9);
await stock('take', 9, 200, { ok: true, left: 0 });
console.log('PASS warehouse HTTP → native keyvalue → Redis and NATS → sync → Redis');
