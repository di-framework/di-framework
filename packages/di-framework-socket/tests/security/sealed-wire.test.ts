import { describe, expect, it } from 'bun:test';
import {
  decodeSealedBinary,
  encodeSealedBinary,
  encodeSealedJson,
  frameFromOpened,
  SEALED_MAGIC,
  SEALED_WIRE_VERSION,
  sealedBodyFromB64,
  sealedBodyToB64,
  tryParseSealedJson,
} from '../../src/security/sealed-wire.ts';

function fakeSealedBody(): Uint8Array {
  // 12-byte iv + 16-byte tag minimum for decodeSealedBinary's length check.
  return new Uint8Array(28).fill(7);
}

describe('encodeSealedBinary / decodeSealedBinary', () => {
  it('round-trips kind, counter, and sealed body', () => {
    const sealedBody = fakeSealedBody();
    const wire = encodeSealedBinary({ kind: 'text', counter: 42n, sealedBody });
    const decoded = decodeSealedBinary(wire);
    expect(decoded.kind).toBe('text');
    expect(decoded.counter).toBe(42n);
    expect([...decoded.sealedBody]).toEqual([...sealedBody]);
  });

  it('round-trips a binary kind', () => {
    const wire = encodeSealedBinary({ kind: 'binary', counter: 0n, sealedBody: fakeSealedBody() });
    expect(decodeSealedBinary(wire).kind).toBe('binary');
  });

  it('rejects a frame shorter than the minimum sealed length', () => {
    expect(() => decodeSealedBinary(new Uint8Array(10))).toThrow(/too short/);
  });

  it('rejects a bad magic prefix', () => {
    const wire = encodeSealedBinary({ kind: 'text', counter: 1n, sealedBody: fakeSealedBody() });
    wire[0] = 0;
    expect(() => decodeSealedBinary(wire)).toThrow(/magic mismatch/);
    wire[0] = SEALED_MAGIC[0]!;
    wire[1] = 0;
    expect(() => decodeSealedBinary(wire)).toThrow(/magic mismatch/);
  });

  it('rejects an unsupported wire version', () => {
    const wire = encodeSealedBinary({ kind: 'text', counter: 1n, sealedBody: fakeSealedBody() });
    wire[2] = SEALED_WIRE_VERSION + 1;
    expect(() => decodeSealedBinary(wire)).toThrow(/version/);
  });
});

describe('encodeSealedJson / tryParseSealedJson', () => {
  it('round-trips sessionId, kind, counter, and sealed body', () => {
    const sealedBody = fakeSealedBody();
    const json = encodeSealedJson({ sessionId: 'sess-1', kind: 'binary', counter: 7n, sealedBody });
    const parsed = tryParseSealedJson(json);
    expect(parsed).not.toBeNull();
    expect(parsed?.sessionId).toBe('sess-1');
    expect(parsed?.kind).toBe('binary');
    expect(parsed?.counter).toBe(7n);
    expect([...(parsed?.sealedBody ?? [])]).toEqual([...sealedBody]);
  });

  it('defaults kind to "binary" when the JSON kind field is missing or unrecognized', () => {
    const json = JSON.stringify({
      type: 'di-socket/sealed',
      sessionId: 's',
      counter: '0',
      payload: 'AA',
    });
    expect(tryParseSealedJson(json)?.kind).toBe('binary');

    const jsonWeirdKind = JSON.stringify({
      type: 'di-socket/sealed',
      sessionId: 's',
      kind: 'something-else',
      counter: '0',
      payload: 'AA',
    });
    expect(tryParseSealedJson(jsonWeirdKind)?.kind).toBe('binary');
  });

  it('returns null for invalid JSON', () => {
    expect(tryParseSealedJson('not json{')).toBeNull();
  });

  it('returns null for well-formed JSON with the wrong envelope type', () => {
    expect(tryParseSealedJson(JSON.stringify({ type: 'other' }))).toBeNull();
    expect(tryParseSealedJson(JSON.stringify('a string'))).toBeNull();
    expect(tryParseSealedJson(JSON.stringify(null))).toBeNull();
  });

  it('returns null when required string fields are missing or the wrong type', () => {
    expect(
      tryParseSealedJson(JSON.stringify({ type: 'di-socket/sealed', counter: '0', payload: 'AA' })),
    ).toBeNull();
    expect(
      tryParseSealedJson(
        JSON.stringify({ type: 'di-socket/sealed', sessionId: 's', payload: 'AA' }),
      ),
    ).toBeNull();
    expect(
      tryParseSealedJson(
        JSON.stringify({ type: 'di-socket/sealed', sessionId: 's', counter: 0, payload: 'AA' }),
      ),
    ).toBeNull();
    expect(
      tryParseSealedJson(JSON.stringify({ type: 'di-socket/sealed', sessionId: 's', counter: '0' })),
    ).toBeNull();
  });
});

describe('frameFromOpened', () => {
  it('decodes text frames as UTF-8 strings', () => {
    const plaintext = new TextEncoder().encode('hello');
    const frame = frameFromOpened('text', plaintext);
    expect(frame.kind).toBe('text');
    expect(frame.text).toBe('hello');
  });

  it('wraps binary frames as opaque bytes', () => {
    const frame = frameFromOpened('binary', new Uint8Array([1, 2, 3]));
    expect(frame.kind).toBe('binary');
    expect([...frame.data]).toEqual([1, 2, 3]);
  });
});

describe('sealedBodyFromB64 / sealedBodyToB64', () => {
  it('round-trips bytes through base64url', () => {
    const bytes = new Uint8Array([1, 2, 3, 250, 251]);
    expect(sealedBodyFromB64(sealedBodyToB64(bytes))).toEqual(bytes);
  });
});
