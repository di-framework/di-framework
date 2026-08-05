import { describe, expect, it } from 'bun:test';
import {
  binaryFrame,
  decodeUdpEnvelope,
  encodeLengthPrefix,
  encodeUdpEnvelope,
  FramingError,
  LengthPrefixFramer,
  textFrame,
} from '../index.ts';

describe('LengthPrefixFramer', () => {
  it('preserves text vs binary kind across chunk boundaries', () => {
    const text = textFrame('hello');
    const bin = binaryFrame(new Uint8Array([1, 2, 3, 4]));
    const wire = new Uint8Array([...encodeLengthPrefix(text), ...encodeLengthPrefix(bin)]);
    const framer = new LengthPrefixFramer();

    const a = wire.subarray(0, 3);
    const b = wire.subarray(3);
    expect(framer.push(a)).toEqual([]);
    const out = framer.push(b);
    expect(out).toHaveLength(2);
    expect(out[0]!.kind).toBe('text');
    expect(out[0]!.text).toBe('hello');
    expect(out[1]!.kind).toBe('binary');
    expect([...out[1]!.data]).toEqual([1, 2, 3, 4]);
  });

  it('rejects oversized frames', () => {
    const framer = new LengthPrefixFramer(4);
    const big = encodeLengthPrefix(binaryFrame(new Uint8Array(8)), 1_000_000);
    expect(() => framer.push(big)).toThrow(FramingError);
  });

  it('rejects invalid UTF-8 when encoding Uint8Array as text', () => {
    const invalid = new Uint8Array([0xff, 0xfe, 0xfd]);
    expect(() => encodeLengthPrefix(invalid, undefined, 'text')).toThrow();
  });

  it('reset() clears any partially-buffered bytes', () => {
    const framer = new LengthPrefixFramer();
    const wire = encodeLengthPrefix(textFrame('hello'));
    // Push only part of the frame, leaving bytes buffered.
    expect(framer.push(wire.subarray(0, 3))).toEqual([]);
    framer.reset();
    // Pushing the *complete* frame after reset should decode exactly once,
    // proving the earlier partial bytes were discarded (not prepended).
    const frames = framer.push(wire);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.text).toBe('hello');
  });
});

describe('UDP envelope', () => {
  it('round-trips kind, session id, seq, and payload', () => {
    const frame = textFrame('dg');
    const wire = encodeUdpEnvelope('sess1', 42n, frame);
    const decoded = decodeUdpEnvelope(wire);
    expect(decoded.sessionId).toBe('sess1');
    expect(decoded.seq).toBe(42n);
    expect(decoded.frame.kind).toBe('text');
    expect(decoded.frame.text).toBe('dg');
  });

  it('rejects bad magic', () => {
    const wire = encodeUdpEnvelope('s', 1n, binaryFrame(new Uint8Array([1])));
    wire[0] = 0;
    expect(() => decodeUdpEnvelope(wire)).toThrow(FramingError);
  });
});
