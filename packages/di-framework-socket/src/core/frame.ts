/**
 * WebSocket opcode / application frame kind.
 *
 * On WebSocket this maps 1:1 to text (opcode 1) vs binary (opcode 2) frames.
 * For TCP/UDP there is no wire opcode, so we carry `kind` in the length-prefix
 * / UDP envelope so handlers still see the same distinction.
 *
 * Never coerce binary → string (or string → binary) without an explicit
 * encode/decode — that silently corrupts non-UTF-8 payloads and breaks clients
 * that branch on frame type.
 */

export type FrameKind = 'text' | 'binary';

export interface SocketFrame {
  /** Wire / application frame kind. */
  readonly kind: FrameKind;
  /**
   * Payload bytes.
   * - `binary`: the application octets as sent
   * - `text`: UTF-8 encoding of {@link text}
   */
  readonly data: Uint8Array;
  /**
   * UTF-8 string when `kind === 'text'`.
   * Absent for binary frames (do not invent a decode).
   */
  readonly text?: string;
}

export type SendInput = string | Uint8Array | ArrayBuffer | SocketFrame;

export interface SendOptions {
  /**
   * Force frame kind. Defaults:
   * - `string` → text
   * - `Uint8Array` / `ArrayBuffer` → binary
   * - `SocketFrame` → frame.kind
   */
  kind?: FrameKind;
}

/** Build a text frame (WebSocket opcode 1). */
export function textFrame(text: string): SocketFrame {
  return {
    kind: 'text',
    text,
    data: new TextEncoder().encode(text),
  };
}

/** Build a binary frame (WebSocket opcode 2). */
export function binaryFrame(data: Uint8Array | ArrayBuffer): SocketFrame {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  return {
    kind: 'binary',
    data: bytes,
  };
}

/**
 * Normalize a send payload into a {@link SocketFrame}.
 *
 * Defaults preserve intent: strings are text frames, byte buffers are binary.
 * Pass `{ kind: 'text' }` only when you have UTF-8 bytes that must go as text.
 */
export function toFrame(input: SendInput, options?: SendOptions): SocketFrame {
  if (isSocketFrame(input)) {
    if (options?.kind && options.kind !== input.kind) {
      throw new TypeError(
        `Cannot reinterpret ${input.kind} frame as ${options.kind}; construct a new frame explicitly`,
      );
    }
    return input;
  }

  if (typeof input === 'string') {
    const kind = options?.kind ?? 'text';
    if (kind === 'binary') {
      return binaryFrame(new TextEncoder().encode(input));
    }
    return textFrame(input);
  }

  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const kind = options?.kind ?? 'binary';
  if (kind === 'text') {
    // Caller asserted these bytes are UTF-8 text.
    return textFrame(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
  }
  return binaryFrame(bytes);
}

export function isSocketFrame(value: unknown): value is SocketFrame {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    'data' in value &&
    ((value as SocketFrame).kind === 'text' || (value as SocketFrame).kind === 'binary') &&
    (value as SocketFrame).data instanceof Uint8Array
  );
}

/** Kind byte for stream/datagram envelopes (0 = text, 1 = binary). */
export function kindToByte(kind: FrameKind): number {
  return kind === 'text' ? 0 : 1;
}

export function kindFromByte(byte: number): FrameKind {
  if (byte === 0) return 'text';
  if (byte === 1) return 'binary';
  throw new RangeError(`Unknown frame kind byte ${byte}`);
}

/** Wire value for JSON sealed envelopes. */
export function kindToWire(kind: FrameKind): 'text' | 'binary' {
  return kind;
}

export function kindFromWire(value: unknown): FrameKind {
  if (value === 'text' || value === 'binary') return value;
  // Legacy sealed messages without kind: treat as binary (opaque bytes).
  return 'binary';
}
