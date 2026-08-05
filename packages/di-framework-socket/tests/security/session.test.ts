import { describe, expect, it } from 'bun:test';
import { binaryFrame, createMemoryDuplexPair, SecureSession, textFrame } from '../../index.ts';

describe('SecureSession over memory duplex', () => {
  it('handshakes and preserves text vs binary application frames', async () => {
    const { left, right } = createMemoryDuplexPair();

    const consumerP = SecureSession.connect({ role: 'consumer', duplex: right });
    const providerP = SecureSession.connect({ role: 'provider', duplex: left });

    const [provider, consumer] = await Promise.all([providerP, consumerP]);
    expect(provider.getState()).toBe('open');
    expect(consumer.getState()).toBe('open');

    const gotText = new Promise<{ kind: string; text?: string }>((resolve) => {
      consumer.onData((frame) => {
        if (frame.kind === 'text') resolve({ kind: frame.kind, text: frame.text });
      });
    });
    await provider.send(textFrame('ping'));
    expect(await gotText).toEqual({ kind: 'text', text: 'ping' });

    const gotBin = new Promise<number[]>((resolve) => {
      provider.onData((frame) => {
        if (frame.kind === 'binary') resolve([...frame.data]);
      });
    });
    await consumer.send(binaryFrame(new Uint8Array([9, 8, 7])));
    expect(await gotBin).toEqual([9, 8, 7]);

    // string default → text
    const gotStr = new Promise<string>((resolve) => {
      consumer.onData((frame) => {
        if (frame.text === 'hi') resolve(frame.kind);
      });
    });
    await provider.send('hi');
    expect(await gotStr).toBe('text');

    // Uint8Array default → binary
    const gotBytes = new Promise<string>((resolve) => {
      consumer.onData((frame) => {
        if (frame.data.length === 2 && frame.data[0] === 1) resolve(frame.kind);
      });
    });
    await provider.send(new Uint8Array([1, 2]));
    expect(await gotBytes).toBe('binary');

    provider.close();
    consumer.close();
  });
});
