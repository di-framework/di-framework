import { describe, expect, it } from 'bun:test';
import {
  AeadChannel,
  base64UrlDecode,
  base64UrlEncode,
  HandshakeError,
  PROTOCOL_VERSION,
  runHandshakePair,
  SecureHandshakeConsumer,
  SecureHandshakeProvider,
  SUITE_V1,
  timingSafeEqual,
} from '../../index.ts';

describe('Secure handshake', () => {
  it('completes mutual confirmation and derives identical encryption keys', async () => {
    const { provider, consumer, providerMaterial, consumerMaterial } = await runHandshakePair();

    expect(provider.isConfirmed()).toBe(true);
    expect(consumer.isConfirmed()).toBe(true);
    expect(providerMaterial.sessionId).toBe(consumerMaterial.sessionId);
    expect(
      await timingSafeEqual(
        providerMaterial.encryptionKeyBytes,
        consumerMaterial.encryptionKeyBytes,
      ),
    ).toBe(true);

    provider.destroy();
    consumer.destroy();
  });

  it('rejects wrong protocol version', async () => {
    const provider = await SecureHandshakeProvider.create();
    const consumer = await SecureHandshakeConsumer.create();
    const init = provider.start();
    await expect(
      consumer.handleInit({ ...init, version: 99 as typeof PROTOCOL_VERSION }),
    ).rejects.toMatchObject({ code: 'version_mismatch' });
    provider.destroy();
    consumer.destroy();
  });

  it('rejects unsupported suite', async () => {
    const provider = await SecureHandshakeProvider.create();
    const consumer = await SecureHandshakeConsumer.create();
    const init = provider.start();
    await expect(consumer.handleInit({ ...init, supportedSuites: ['none'] })).rejects.toMatchObject(
      { code: 'suite_mismatch' },
    );
    provider.destroy();
    consumer.destroy();
  });

  it('rejects session id mismatch on response', async () => {
    const provider = await SecureHandshakeProvider.create();
    const consumer = await SecureHandshakeConsumer.create();
    const init = provider.start();
    const response = await consumer.handleInit(init);
    await expect(provider.handleResponse({ ...response, sessionId: 'AAAA' })).rejects.toMatchObject(
      { code: 'session_mismatch' },
    );
    provider.destroy();
    consumer.destroy();
  });

  it('detects MITM via altered confirmation MAC', async () => {
    const provider = await SecureHandshakeProvider.create();
    const consumer = await SecureHandshakeConsumer.create();
    const init = provider.start();
    const response = await consumer.handleInit(init);
    const confReq = await provider.handleResponse(response);
    const conf = await consumer.handleConfirmationRequest(confReq);

    // Flip a payload byte (not a base64 character). Mutating the last base64
    // char can produce non-canonical trailing bits and fail at decode instead
    // of the MAC check — that flake is what broke Linux CI.
    const mac = base64UrlDecode(conf.confirmationMac);
    mac[0] = (mac[0]! ^ 0xff) & 0xff;
    const tamperedMac = base64UrlEncode(mac);

    await expect(
      provider.handleConfirmation({
        ...conf,
        confirmationMac: tamperedMac,
      }),
    ).rejects.toMatchObject({ code: 'confirmation_failed' });

    provider.destroy();
    consumer.destroy();
  });

  it('refuses exportKeys before confirmation', async () => {
    const provider = await SecureHandshakeProvider.create();
    expect(() => provider.exportKeys()).toThrow(HandshakeError);
    provider.destroy();
  });

  it('derives different keys for different sessions', async () => {
    const a = await runHandshakePair();
    const b = await runHandshakePair();
    expect(a.providerMaterial.sessionId).not.toBe(b.providerMaterial.sessionId);
    expect(
      await timingSafeEqual(
        a.providerMaterial.encryptionKeyBytes,
        b.providerMaterial.encryptionKeyBytes,
      ),
    ).toBe(false);
    a.provider.destroy();
    a.consumer.destroy();
    b.provider.destroy();
    b.consumer.destroy();
  });

  it('advertises the v1 suite', async () => {
    const provider = await SecureHandshakeProvider.create();
    const init = provider.start();
    expect(init.version).toBe(PROTOCOL_VERSION);
    expect(init.supportedSuites).toContain(SUITE_V1);
    provider.destroy();
  });
});

describe('AeadChannel', () => {
  it('round-trips sealed payloads with counter + kind AAD', async () => {
    const { providerMaterial, provider, consumer } = await runHandshakePair();
    const alice = await AeadChannel.of(
      providerMaterial.encryptionKeyBytes,
      providerMaterial.sessionId,
    );
    const bob = await AeadChannel.of(
      providerMaterial.encryptionKeyBytes.slice(),
      providerMaterial.sessionId,
    );

    const sealed = await alice.seal(new TextEncoder().encode('hello secure world'), 'text');
    const opened = await bob.open(sealed.counter, sealed.ciphertextB64, 'text');
    expect(new TextDecoder().decode(opened)).toBe('hello secure world');

    alice.destroy();
    bob.destroy();
    provider.destroy();
    consumer.destroy();
  });

  it('rejects opening with the wrong frame kind', async () => {
    const { providerMaterial, provider, consumer } = await runHandshakePair();
    const channel = await AeadChannel.of(
      providerMaterial.encryptionKeyBytes,
      providerMaterial.sessionId,
    );
    const sealed = await channel.seal(new Uint8Array([1, 2, 3]), 'binary');
    await expect(channel.open(sealed.counter, sealed.ciphertextB64, 'text')).rejects.toThrow(
      /Decryption failed/,
    );
    channel.destroy();
    provider.destroy();
    consumer.destroy();
  });

  it('rejects tampered ciphertext', async () => {
    const { providerMaterial, provider, consumer } = await runHandshakePair();
    const channel = await AeadChannel.of(
      providerMaterial.encryptionKeyBytes,
      providerMaterial.sessionId,
    );
    const sealed = await channel.seal(new TextEncoder().encode('secret'), 'text');
    const tampered =
      sealed.ciphertextB64.slice(0, -2) + (sealed.ciphertextB64.endsWith('AA') ? 'BB' : 'AA');
    await expect(channel.open(sealed.counter, tampered, 'text')).rejects.toThrow(
      /Decryption failed|Malformed/,
    );
    channel.destroy();
    provider.destroy();
    consumer.destroy();
  });

  it('rejects replayed counters', async () => {
    const { providerMaterial, provider, consumer } = await runHandshakePair();
    const sender = await AeadChannel.of(
      providerMaterial.encryptionKeyBytes,
      providerMaterial.sessionId,
    );
    const receiver = await AeadChannel.of(
      providerMaterial.encryptionKeyBytes.slice(),
      providerMaterial.sessionId,
    );
    const first = await sender.seal(new TextEncoder().encode('one'), 'text');
    await receiver.open(first.counter, first.ciphertextB64, 'text');
    await expect(receiver.open(first.counter, first.ciphertextB64, 'text')).rejects.toThrow(
      /Replay/,
    );
    sender.destroy();
    receiver.destroy();
    provider.destroy();
    consumer.destroy();
  });

  it('cannot seal after destroy', async () => {
    const { providerMaterial, provider, consumer } = await runHandshakePair();
    const channel = await AeadChannel.of(
      providerMaterial.encryptionKeyBytes,
      providerMaterial.sessionId,
    );
    channel.destroy();
    await expect(channel.seal(new Uint8Array([1]), 'binary')).rejects.toThrow(/destroyed/);
    provider.destroy();
    consumer.destroy();
  });

  it('exportSnapshot / restore keeps counters working', async () => {
    const { providerMaterial, provider, consumer } = await runHandshakePair();
    const alice = await AeadChannel.of(
      providerMaterial.encryptionKeyBytes,
      providerMaterial.sessionId,
    );
    const sealed = await alice.seal(new TextEncoder().encode('z'), 'text');
    const snap = alice.exportSnapshot();
    alice.destroy();

    const restored = await AeadChannel.restore(snap);
    const bob = await AeadChannel.of(
      providerMaterial.encryptionKeyBytes.slice(),
      providerMaterial.sessionId,
    );
    // bob still at counter 0 — open the message sealed before export
    const opened = await bob.open(sealed.counter, sealed.ciphertextB64, 'text');
    expect(new TextDecoder().decode(opened)).toBe('z');

    // restored continues send counters after the seal
    const next = await restored.seal(new TextEncoder().encode('y'), 'text');
    expect(next.counter).toBe(sealed.counter + 1n);

    restored.destroy();
    bob.destroy();
    provider.destroy();
    consumer.destroy();
  });
});
