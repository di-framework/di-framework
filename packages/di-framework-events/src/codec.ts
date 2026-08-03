import type { EventCodec } from './types.ts';

/** UTF-8 JSON codec — the default for all transports. */
export const JsonCodec: EventCodec = {
  encode(payload: unknown): string {
    return JSON.stringify(payload === undefined ? null : payload);
  },
  decode(data: Uint8Array | string): unknown {
    const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
    if (text.length === 0) return null;
    return JSON.parse(text);
  },
};

export function bytesFromCodecOutput(encoded: Uint8Array | string): Uint8Array {
  if (typeof encoded === 'string') return new TextEncoder().encode(encoded);
  return encoded;
}

export function stringFromCodecOutput(encoded: Uint8Array | string): string {
  if (typeof encoded === 'string') return encoded;
  return new TextDecoder().decode(encoded);
}
