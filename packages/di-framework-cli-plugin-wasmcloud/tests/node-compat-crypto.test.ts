import { afterEach, describe, expect, it, mock } from 'bun:test';
import { createHash as nodeCreateHash, createHmac as nodeCreateHmac } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_DEPS } from '../src/deps';
import { hostInterfacesFromRequirements } from '../src/host-interface';
import { runtimeRequirementsFromJavaScript } from '../src/wit';
import { getRandomBytes, resetMemoryRandom } from './memory-wasi-random';

mock.module('wasi:random/random@0.3.0', () => ({ getRandomBytes }));

const {
  createHash,
  createHmac,
  createCipheriv,
  getRandomValues,
  randomBytes,
  randomUUID,
  subtle,
  timingSafeEqual,
  webcrypto,
} = await import('../src/node-compat/crypto');

afterEach(() => {
  resetMemoryRandom();
});

describe('node:crypto overlay', () => {
  it('matches Node createHash for sha1 and sha256, including the WebSocket accept key', () => {
    expect(createHash('sha256').update('abc').digest('hex')).toBe(
      nodeCreateHash('sha256').update('abc').digest('hex'),
    );
    expect(createHash('sha1').update('abc').digest('base64')).toBe(
      nodeCreateHash('sha1').update('abc').digest('base64'),
    );
    const guid = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
    const key = 'dGhlIHNhbXBsZSBub25jZQ==';
    expect(
      createHash('sha1')
        .update(key + guid)
        .digest('base64'),
    ).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
  });

  it('matches Node HMAC-SHA256 and copies hash state', () => {
    const key = 'secret';
    expect(createHmac('sha256', key).update('msg').digest('hex')).toBe(
      nodeCreateHmac('sha256', key).update('msg').digest('hex'),
    );
    const hash = createHash('sha256').update('ab');
    const copy = hash.copy();
    hash.update('c');
    copy.update('c');
    expect(hash.digest('hex')).toBe(copy.digest('hex'));
  });

  it('issues v4 UUIDs, fills typed arrays, and compares in constant time', () => {
    const id = randomUUID();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const target = new Uint8Array(8);
    expect(getRandomValues(target)).toBe(target);
    expect(target.length).toBe(8);
    const bytes = randomBytes(16);
    expect(bytes.length).toBe(16);
    expect(timingSafeEqual(bytes, bytes)).toBe(true);
    expect(() => timingSafeEqual(bytes, bytes.subarray(0, 8))).toThrow(/same byte length/);
  });

  it('throws for unsupported Node OpenSSL APIs and unknown digests', () => {
    expect(() => createHash('not-a-hash')).toThrow(/Digest method not supported/);
    expect(() => createCipheriv()).toThrow(/not implemented/);
  });
});

describe('Web Crypto subset', () => {
  it('matches host Web Crypto for digest, HMAC, HKDF, and AES-GCM with AAD', async () => {
    const payload = new TextEncoder().encode('wasmcloud-crypto');
    const digest = new Uint8Array(await subtle.digest('SHA-256', payload));
    const hostDigest = new Uint8Array(await crypto.subtle.digest('SHA-256', payload));
    expect(digest).toEqual(hostDigest);

    const hmacKeyBytes = new Uint8Array(32).fill(9);
    const hmacKey = await subtle.importKey(
      'raw',
      hmacKeyBytes,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const hostHmacKey = await crypto.subtle.importKey(
      'raw',
      hmacKeyBytes,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    expect(new Uint8Array(await subtle.sign('HMAC', hmacKey, payload))).toEqual(
      new Uint8Array(await crypto.subtle.sign('HMAC', hostHmacKey, payload)),
    );

    const ikm = new Uint8Array(32).fill(3);
    const salt = new Uint8Array(16).fill(4);
    const info = new TextEncoder().encode('di-framework/socket:v1:encryption');
    const hkdfKey = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
    const hostHkdfKey = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
    const hkdfBits = new Uint8Array(
      await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, hkdfKey, 256),
    );
    const hostHkdf = new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: 'HKDF', hash: 'SHA-256', salt, info },
        hostHkdfKey,
        256,
      ),
    );
    expect(hkdfBits).toEqual(hostHkdf);

    const aesKeyBytes = new Uint8Array(32).fill(7);
    const iv = new Uint8Array(12).fill(1);
    const aad = new TextEncoder().encode('session|1|text');
    const aesKey = await subtle.importKey('raw', aesKeyBytes, { name: 'AES-GCM' }, false, [
      'encrypt',
      'decrypt',
    ]);
    const hostAes = await crypto.subtle.importKey('raw', aesKeyBytes, { name: 'AES-GCM' }, false, [
      'encrypt',
      'decrypt',
    ]);
    const ciphertext = new Uint8Array(
      await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, aesKey, payload),
    );
    const hostCiphertext = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, hostAes, payload),
    );
    expect(ciphertext).toEqual(hostCiphertext);
    expect(
      new TextDecoder().decode(
        new Uint8Array(
          await subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad }, aesKey, ciphertext),
        ),
      ),
    ).toBe('wasmcloud-crypto');
  });

  it('round-trips ECDH P-256 deriveBits', async () => {
    const left = (await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, [
      'deriveBits',
    ])) as { publicKey: CryptoKey; privateKey: CryptoKey };
    const right = (await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, [
      'deriveBits',
    ])) as { publicKey: CryptoKey; privateKey: CryptoKey };
    const exported = new Uint8Array((await subtle.exportKey('raw', left.publicKey)) as ArrayBuffer);
    expect(exported.length).toBe(65);
    expect(exported[0]).toBe(0x04);
    const ab = await subtle.deriveBits(
      { name: 'ECDH', public: right.publicKey },
      left.privateKey,
      256,
    );
    const ba = await subtle.deriveBits(
      { name: 'ECDH', public: left.publicKey },
      right.privateKey,
      256,
    );
    expect(new Uint8Array(ab)).toEqual(new Uint8Array(ba));
    expect(ab.byteLength).toBe(32);
  });

  it('exposes the same object as the injected webcrypto global', () => {
    expect(webcrypto.subtle).toBe(subtle);
    expect(webcrypto.randomUUID).toBe(randomUUID);
  });
});

describe('wasi:random requirements', () => {
  it('adds wasi:random to the guest world and keeps it off hostInterfaces', () => {
    expect(runtimeRequirementsFromJavaScript('export const bundled = true;\n')).toEqual([]);
    const requirements = runtimeRequirementsFromJavaScript(
      'import { getRandomBytes } from "wasi:random/random@0.3.0";\n',
    );
    expect(requirements).toEqual([
      expect.objectContaining({
        package: 'wasi:random',
        version: '0.3.0',
        interfaces: ['random'],
        direction: 'import',
        source: 'node-compat',
      }),
    ]);
    expect(hostInterfacesFromRequirements(requirements)).toEqual([]);
  });
});

describe('bundled node:crypto overlay', () => {
  it('keeps wasi:random imports external and hashes in the guest bundle', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wasmcloud-crypto-bundle-'));
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
import { createHash, randomUUID } from 'node:crypto';
export default {
  hex: createHash('sha256').update('abc').digest('hex'),
  uuid: randomUUID(),
};
`,
    );
    await DEFAULT_DEPS.bundler({ adapterPath, entryPath, outFile });
    const source = await Bun.file(outFile).text();
    expect(source).toContain('wasi:random/random@0.3.0');
    expect(source).not.toContain('wasi:sockets/types@0.3.0');
    const bundled = await import(pathToFileURL(outFile).href);
    expect(bundled.handler.hex).toBe(nodeCreateHash('sha256').update('abc').digest('hex'));
    expect(bundled.handler.uuid).toMatch(/^[0-9a-f-]{36}$/);
  });
});
