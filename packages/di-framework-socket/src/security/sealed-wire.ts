/**
 * Compact **binary** wire format for sealed application frames after handshake.
 *
 * Handshake messages stay JSON on **text** WebSocket frames.
 * Application traffic after confirmation is sealed and sent as **binary** frames:
 *
 * ```
 * magic(2) 0xDF 0x53
 * version(1) = 1
 * appKind(1)  0=text 1=binary   ← original application frame kind
 * counter(u64 be)
 * iv(12)
 * ciphertext ‖ gcm-tag
 * ```
 *
 * Binary-vs-text is preserved end-to-end and authenticated in AEAD AAD.
 */

import {
  binaryFrame,
  type FrameKind,
  kindFromByte,
  kindToByte,
  type SocketFrame,
  textFrame,
} from '../core/frame.ts';
import { base64UrlDecode, base64UrlEncode, concatBytes, u64Be } from './bytes.ts';

export const SEALED_MAGIC = new Uint8Array([0xdf, 0x53]);
export const SEALED_WIRE_VERSION = 1;
const NONCE_BYTES = 12;

export function encodeSealedBinary(parts: {
  kind: FrameKind;
  counter: bigint;
  /** iv ‖ ciphertext‖tag */
  sealedBody: Uint8Array;
}): Uint8Array {
  const header = new Uint8Array(2 + 1 + 1 + 8);
  header[0] = SEALED_MAGIC[0]!;
  header[1] = SEALED_MAGIC[1]!;
  header[2] = SEALED_WIRE_VERSION;
  header[3] = kindToByte(parts.kind);
  header.set(u64Be(parts.counter), 4);
  return concatBytes(header, parts.sealedBody);
}

export function decodeSealedBinary(raw: Uint8Array): {
  kind: FrameKind;
  counter: bigint;
  sealedBody: Uint8Array;
} {
  if (raw.length < 2 + 1 + 1 + 8 + NONCE_BYTES + 16) {
    throw new Error('Sealed binary frame too short');
  }
  if (raw[0] !== SEALED_MAGIC[0] || raw[1] !== SEALED_MAGIC[1]) {
    throw new Error('Sealed binary magic mismatch');
  }
  if (raw[2] !== SEALED_WIRE_VERSION) {
    throw new Error('Unsupported sealed wire version');
  }
  const kind = kindFromByte(raw[3]!);
  let counter = 0n;
  for (let i = 0; i < 8; i++) counter = (counter << 8n) | BigInt(raw[4 + i]!);
  return {
    kind,
    counter,
    sealedBody: raw.subarray(12),
  };
}

/** JSON sealed envelope (text frame) — includes `kind` so text path preserves frame type. */
export function encodeSealedJson(parts: {
  sessionId: string;
  kind: FrameKind;
  counter: bigint;
  sealedBody: Uint8Array;
}): string {
  return JSON.stringify({
    type: 'di-socket/sealed',
    sessionId: parts.sessionId,
    kind: parts.kind,
    counter: parts.counter.toString(),
    payload: base64UrlEncode(parts.sealedBody),
  });
}

export function tryParseSealedJson(text: string): {
  sessionId: string;
  kind: FrameKind;
  counter: bigint;
  sealedBody: Uint8Array;
} | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    (parsed as { type?: string }).type !== 'di-socket/sealed'
  ) {
    return null;
  }
  const p = parsed as {
    sessionId?: string;
    kind?: string;
    counter?: string;
    payload?: string;
  };
  if (
    typeof p.sessionId !== 'string' ||
    typeof p.counter !== 'string' ||
    typeof p.payload !== 'string'
  ) {
    return null;
  }
  const kind: FrameKind = p.kind === 'text' ? 'text' : 'binary';
  return {
    sessionId: p.sessionId,
    kind,
    counter: BigInt(p.counter),
    sealedBody: base64UrlDecode(p.payload),
  };
}

export function frameFromOpened(kind: FrameKind, plaintext: Uint8Array): SocketFrame {
  if (kind === 'text') {
    return textFrame(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(plaintext));
  }
  return binaryFrame(plaintext);
}

export function sealedBodyFromB64(ciphertextB64: string): Uint8Array {
  return base64UrlDecode(ciphertextB64);
}

export function sealedBodyToB64(body: Uint8Array): string {
  return base64UrlEncode(body);
}
