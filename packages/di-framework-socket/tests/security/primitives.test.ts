import { describe, expect, it } from 'bun:test';
import { base64UrlEncode } from '../../src/security/bytes.ts';
import { generateEcdhKeyPair, importEcdhPublicKey } from '../../src/security/ecdh.ts';
import { hkdf } from '../../src/security/kdf.ts';
import {
  isProtocolMessage,
  type ProtocolMessage,
  parseProtocolMessage,
} from '../../src/security/protocol.ts';

describe('importEcdhPublicKey', () => {
  it('imports a valid uncompressed P-256 public key', async () => {
    const pair = await generateEcdhKeyPair();
    const imported = await importEcdhPublicKey(pair.publicKeyB64);
    expect(imported).toBeDefined();
  });

  it('rejects a key that is not 65 bytes / does not start with 0x04', async () => {
    await expect(importEcdhPublicKey(base64UrlEncode(new Uint8Array(10)))).rejects.toThrow(
      /uncompressed 65-byte point/,
    );
    const wrongPrefix = new Uint8Array(65);
    wrongPrefix[0] = 0x05;
    await expect(importEcdhPublicKey(base64UrlEncode(wrongPrefix))).rejects.toThrow(
      /uncompressed 65-byte point/,
    );
  });
});

describe('hkdf', () => {
  it('derives the requested number of bytes', async () => {
    const out = await hkdf(new Uint8Array(32), new Uint8Array(16), 'label', 16);
    expect(out.length).toBe(16);
  });

  it('rejects a length outside the valid HKDF-SHA-256 output range', async () => {
    await expect(hkdf(new Uint8Array(32), new Uint8Array(16), 'label', 0)).rejects.toThrow(
      RangeError,
    );
    await expect(
      hkdf(new Uint8Array(32), new Uint8Array(16), 'label', 255 * 32 + 1),
    ).rejects.toThrow(RangeError);
  });
});

describe('isProtocolMessage / parseProtocolMessage', () => {
  it('accepts objects whose "type" starts with "di-socket/"', () => {
    expect(isProtocolMessage({ type: 'di-socket/handshake-init' })).toBe(true);
  });

  it('rejects non-objects and objects without a matching type', () => {
    expect(isProtocolMessage(null)).toBe(false);
    expect(isProtocolMessage('str')).toBe(false);
    expect(isProtocolMessage({ type: 42 })).toBe(false);
    expect(isProtocolMessage({ type: 'other/thing' })).toBe(false);
  });

  it('parses a valid di-socket message from a string or bytes', () => {
    const msg = { type: 'di-socket/handshake-init' } as ProtocolMessage;
    expect(parseProtocolMessage(JSON.stringify(msg))).toEqual(msg);
    expect(parseProtocolMessage(new TextEncoder().encode(JSON.stringify(msg)))).toEqual(msg);
  });

  it('throws for malformed JSON', () => {
    expect(() => parseProtocolMessage('not json{')).toThrow(/not JSON/);
  });

  it('throws for well-formed JSON that is missing the di-socket type', () => {
    expect(() => parseProtocolMessage(JSON.stringify({ type: 'other/thing' }))).toThrow(
      /missing di-socket type/,
    );
  });
});
