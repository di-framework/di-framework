/**
 * Length-prefix framing for stream protocols (TCP).
 *
 * Wire: big-endian uint32 length ‖ kind(1) ‖ payload
 * - kind 0 = text (UTF-8 payload)
 * - kind 1 = binary
 *
 * Length covers kind + payload (not the 4-byte length field itself).
 *
 * Uses a class expression (not `export class`) so Bun's line coverage attributes
 * the declaration when the module loads — `export class` with an explicit
 * constructor leaves the class keyword line at 0 hits.
 */

import {
  binaryFrame,
  type FrameKind,
  kindFromByte,
  kindToByte,
  type SocketFrame,
  textFrame,
} from './frame.ts';

export class FramingError extends Error {
  override readonly name = 'FramingError';
}

const MAX_DEFAULT = 1_048_576; // 1 MiB

export const LengthPrefixFramer = class LengthPrefixFramer {
  #buffer: Uint8Array;
  #maxPayloadBytes: number;

  constructor(maxPayloadBytes: number = MAX_DEFAULT) {
    this.#buffer = new Uint8Array(0);
    this.#maxPayloadBytes = maxPayloadBytes;
  }

  /** Push stream bytes; returns zero or more complete frames. */
  push(chunk: Uint8Array): SocketFrame[] {
    this.#buffer = concat(this.#buffer, chunk) as Uint8Array;
    const frames: SocketFrame[] = [];

    while (this.#buffer.length >= 4) {
      const len =
        ((this.#buffer[0]! << 24) |
          (this.#buffer[1]! << 16) |
          (this.#buffer[2]! << 8) |
          this.#buffer[3]!) >>>
        0;
      if (len > this.#maxPayloadBytes + 1) {
        throw new FramingError(`Frame length ${len} exceeds max ${this.#maxPayloadBytes + 1}`);
      }
      if (len < 1) {
        throw new FramingError('Frame length must include kind byte');
      }
      if (this.#buffer.length < 4 + len) break;
      const body = this.#buffer.subarray(4, 4 + len);
      frames.push(decodeFramedBody(body));
      this.#buffer = this.#buffer.subarray(4 + len);
    }

    return frames;
  }

  reset(): void {
    this.#buffer = new Uint8Array(0);
  }
};

const strictUtf8 = () => new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });

/** Encode a single length-prefixed frame with kind byte. */
export function encodeLengthPrefix(
  frame: SocketFrame | Uint8Array,
  maxPayloadBytes = MAX_DEFAULT,
  kind: FrameKind = 'binary',
): Uint8Array {
  const f: SocketFrame =
    frame instanceof Uint8Array
      ? kind === 'text'
        ? textFrame(strictUtf8().decode(frame))
        : { kind, data: frame }
      : frame;

  if (f.data.length > maxPayloadBytes) {
    throw new FramingError(`Payload ${f.data.length} exceeds max ${maxPayloadBytes}`);
  }
  const bodyLen = 1 + f.data.length;
  const out = new Uint8Array(4 + bodyLen);
  out[0] = (bodyLen >>> 24) & 0xff;
  out[1] = (bodyLen >>> 16) & 0xff;
  out[2] = (bodyLen >>> 8) & 0xff;
  out[3] = bodyLen & 0xff;
  out[4] = kindToByte(f.kind);
  out.set(f.data, 5);
  return out;
}

function decodeFramedBody(body: Uint8Array): SocketFrame {
  const kind = kindFromByte(body[0]!);
  const payload = body.subarray(1);
  if (kind === 'text') {
    return textFrame(strictUtf8().decode(payload));
  }
  return binaryFrame(payload);
}

/**
 * UDP datagram envelope (v1):
 * magic(2) = 0xDF 0x53 ‖ version(1) ‖ kind(1) ‖ sessionIdLen(1) ‖ sessionId ‖ seq(u64 be) ‖ payload
 *
 * `kind` is the application frame kind (text/binary). Handshake knock uses binary empty payload.
 */
export const UDP_MAGIC = new Uint8Array([0xdf, 0x53]);
export const UDP_ENVELOPE_VERSION = 1;

export function encodeUdpEnvelope(
  sessionId: string,
  seq: bigint,
  frame: SocketFrame | Uint8Array,
  kind: FrameKind = 'binary',
): Uint8Array {
  const f: SocketFrame =
    frame instanceof Uint8Array
      ? kind === 'text'
        ? textFrame(strictUtf8().decode(frame))
        : binaryFrame(frame)
      : frame;

  const sid = new TextEncoder().encode(sessionId);
  if (sid.length > 255) throw new FramingError('sessionId too long for UDP envelope');
  const out = new Uint8Array(2 + 1 + 1 + 1 + sid.length + 8 + f.data.length);
  let o = 0;
  out[o++] = UDP_MAGIC[0]!;
  out[o++] = UDP_MAGIC[1]!;
  out[o++] = UDP_ENVELOPE_VERSION;
  out[o++] = kindToByte(f.kind);
  out[o++] = sid.length;
  out.set(sid, o);
  o += sid.length;
  for (let i = 7; i >= 0; i--) {
    out[o + i] = Number((seq >> BigInt((7 - i) * 8)) & 0xffn);
  }
  o += 8;
  out.set(f.data, o);
  return out;
}

export function decodeUdpEnvelope(datagram: Uint8Array): {
  sessionId: string;
  seq: bigint;
  frame: SocketFrame;
} {
  if (datagram.length < 2 + 1 + 1 + 1 + 8) {
    throw new FramingError('UDP envelope too short');
  }
  if (datagram[0] !== UDP_MAGIC[0] || datagram[1] !== UDP_MAGIC[1]) {
    throw new FramingError('UDP envelope magic mismatch');
  }
  if (datagram[2] !== UDP_ENVELOPE_VERSION) {
    throw new FramingError('Unsupported UDP envelope version');
  }
  const kind = kindFromByte(datagram[3]!);
  const sidLen = datagram[4]!;
  if (datagram.length < 5 + sidLen + 8) throw new FramingError('UDP envelope truncated');
  const sessionId = new TextDecoder().decode(datagram.subarray(5, 5 + sidLen));
  let seq = 0n;
  const seqOff = 5 + sidLen;
  for (let i = 0; i < 8; i++) seq = (seq << 8n) | BigInt(datagram[seqOff + i]!);
  const payload = datagram.subarray(seqOff + 8);
  const frame = kind === 'text' ? textFrame(strictUtf8().decode(payload)) : binaryFrame(payload);
  return { sessionId, seq, frame };
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}
