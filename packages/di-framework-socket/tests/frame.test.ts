import { describe, expect, it } from 'bun:test';
import {
  binaryFrame,
  isSocketFrame,
  kindFromByte,
  kindFromWire,
  kindToByte,
  kindToWire,
  textFrame,
  toFrame,
} from '../src/core/frame.ts';

describe('toFrame - explicit kind overrides and reinterpretation', () => {
  it('throws when reinterpreting an existing SocketFrame with a conflicting kind', () => {
    const frame = textFrame('hi');
    expect(() => toFrame(frame, { kind: 'binary' })).toThrow(/Cannot reinterpret/);
  });

  it('passes an existing SocketFrame through unchanged when kind matches or is omitted', () => {
    const frame = textFrame('hi');
    expect(toFrame(frame)).toBe(frame);
    expect(toFrame(frame, { kind: 'text' })).toBe(frame);
  });

  it('encodes a string as binary when kind: "binary" is forced', () => {
    const frame = toFrame('hi', { kind: 'binary' });
    expect(frame.kind).toBe('binary');
    expect([...frame.data]).toEqual([...new TextEncoder().encode('hi')]);
  });

  it('decodes Uint8Array bytes as text when kind: "text" is forced', () => {
    const bytes = new TextEncoder().encode('bytes-as-text');
    const frame = toFrame(bytes, { kind: 'text' });
    expect(frame.kind).toBe('text');
    expect(frame.text).toBe('bytes-as-text');
  });

  it('accepts an ArrayBuffer input and defaults to binary', () => {
    const buffer = new Uint8Array([1, 2, 3]).buffer;
    const frame = toFrame(buffer);
    expect(frame.kind).toBe('binary');
    expect([...frame.data]).toEqual([1, 2, 3]);
  });
});

describe('isSocketFrame', () => {
  it('rejects non-object and malformed inputs', () => {
    expect(isSocketFrame(null)).toBe(false);
    expect(isSocketFrame(42)).toBe(false);
    expect(isSocketFrame({ kind: 'text' })).toBe(false);
    expect(isSocketFrame({ kind: 'other', data: new Uint8Array() })).toBe(false);
    expect(isSocketFrame({ kind: 'text', data: 'not bytes' })).toBe(false);
  });

  it('accepts a well-formed frame', () => {
    expect(isSocketFrame(binaryFrame(new Uint8Array([1])))).toBe(true);
  });
});

describe('kind byte/wire helpers', () => {
  it('kindToByte / kindFromByte round-trip text and binary', () => {
    expect(kindToByte('text')).toBe(0);
    expect(kindToByte('binary')).toBe(1);
    expect(kindFromByte(0)).toBe('text');
    expect(kindFromByte(1)).toBe('binary');
  });

  it('kindFromByte throws for an unknown byte', () => {
    expect(() => kindFromByte(2)).toThrow(RangeError);
  });

  it('kindToWire returns the kind as-is', () => {
    expect(kindToWire('text')).toBe('text');
    expect(kindToWire('binary')).toBe('binary');
  });

  it('kindFromWire accepts "text"/"binary" and falls back to "binary" for legacy values', () => {
    expect(kindFromWire('text')).toBe('text');
    expect(kindFromWire('binary')).toBe('binary');
    expect(kindFromWire(undefined)).toBe('binary');
    expect(kindFromWire('unexpected')).toBe('binary');
  });
});
