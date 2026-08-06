import { describe, expect, it } from 'bun:test';
import {
  base64UrlDecode,
  base64UrlEncode,
  concatBytes,
  EncodingError,
  randomBytes,
  readU64Be,
  u64Be,
  utf8Decode,
  utf8Encode,
  zeroize,
} from '../../src/security/bytes.ts';

describe('utf8Encode / utf8Decode', () => {
  it('round-trips a UTF-8 string through bytes', () => {
    const bytes = utf8Encode('héllo wörld');
    expect(utf8Decode(bytes)).toBe('héllo wörld');
  });

  it('throws on malformed UTF-8', () => {
    expect(() => utf8Decode(new Uint8Array([0xff, 0xfe]))).toThrow();
  });
});

describe('u64Be / readU64Be', () => {
  it('round-trips a bigint counter through big-endian bytes', () => {
    const bytes = u64Be(123456789n);
    expect(readU64Be(bytes)).toBe(123456789n);
  });

  it('round-trips at a non-zero offset', () => {
    const bytes = concatBytes(new Uint8Array([0xaa, 0xbb]), u64Be(42n));
    expect(readU64Be(bytes, 2)).toBe(42n);
  });

  it('throws when reading past the end of the buffer', () => {
    expect(() => readU64Be(new Uint8Array(4))).toThrow(RangeError);
  });

  it('accepts a plain number for u64Be', () => {
    expect(readU64Be(u64Be(7))).toBe(7n);
  });

  it('rejects out-of-range values', () => {
    expect(() => u64Be(-1n)).toThrow(RangeError);
    expect(() => u64Be(0xffff_ffff_ffff_ffffn + 1n)).toThrow(RangeError);
  });
});

describe('base64UrlEncode / base64UrlDecode edge cases', () => {
  it('round-trips buffers of every remainder length (0, 1, 2 trailing bytes)', () => {
    for (const length of [0, 1, 2, 3, 4, 5, 6]) {
      const bytes = new Uint8Array(length).map((_, i) => i + 1);
      expect(base64UrlDecode(base64UrlEncode(bytes))).toEqual(bytes);
    }
  });

  it('accepts an ArrayBuffer input', () => {
    const buffer = new Uint8Array([9, 9, 9]).buffer;
    expect(base64UrlEncode(buffer)).toBe(base64UrlEncode(new Uint8Array([9, 9, 9])));
  });

  it('rejects an invalid length (length % 4 === 1)', () => {
    expect(() => base64UrlDecode('A')).toThrow(EncodingError);
  });

  it('rejects an invalid character', () => {
    expect(() => base64UrlDecode('A!==')).toThrow(EncodingError);
  });

  it('rejects non-canonical trailing bits', () => {
    // 'AB' decodes to a single byte with nonzero trailing bits.
    expect(() => base64UrlDecode('AB')).toThrow(/Non-canonical/);
  });
});

describe('randomBytes', () => {
  it('rejects non-positive / non-integer lengths', () => {
    expect(() => randomBytes(0)).toThrow(RangeError);
    expect(() => randomBytes(-1)).toThrow(RangeError);
    expect(() => randomBytes(1.5)).toThrow(RangeError);
  });

  it('fills buffers larger than the 65536-byte getRandomValues limit in chunks', () => {
    const bytes = randomBytes(70_000);
    expect(bytes.length).toBe(70_000);
    // Extremely unlikely to be all zero if actually randomized.
    expect(bytes.some((b) => b !== 0)).toBe(true);
  });
});

describe('zeroize', () => {
  it('overwrites bytes with zero', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    zeroize(bytes);
    expect([...bytes]).toEqual([0, 0, 0]);
  });

  it('is a no-op for null/undefined', () => {
    expect(() => zeroize(undefined)).not.toThrow();
    expect(() => zeroize(null)).not.toThrow();
  });
});
