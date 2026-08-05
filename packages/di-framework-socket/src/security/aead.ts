import type { FrameKind } from '../core/frame.ts';
import {
  base64UrlDecode,
  base64UrlEncode,
  concatBytes,
  randomBytes,
  u64Be,
  zeroize,
} from './bytes.ts';
import { buf, subtle } from './webcrypto.ts';

/** 96-bit IV — the only length for which GCM's security proof is tight. */
const NONCE_BYTES = 12;

export class AeadError extends Error {
  override readonly name = 'AeadError';
}

export interface SessionKeys {
  encryptionKeyBytes: Uint8Array;
  encryptionKey: CryptoKey;
  sessionId: string;
}

export async function importAesGcmKey(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.length !== 32) throw new AeadError(`AES-256 key must be 32 bytes, got ${raw.length}`);
  return subtle.importKey('raw', buf(raw), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

function kindByte(kind: FrameKind): Uint8Array {
  return new Uint8Array([kind === 'text' ? 0 : 1]);
}

/**
 * Authenticated encryption channel for one confirmed session.
 *
 * AAD binds `sessionId`, monotonic counter, and **frame kind** so a ciphertext
 * sealed as binary cannot be opened as text (or the reverse).
 */
/** Serializable AEAD state for hibernation / process migration. */
export interface AeadChannelSnapshot {
  sessionId: string;
  /** Copy of raw AES-256 key material (32 bytes). Treat as secret. */
  encryptionKeyBytes: Uint8Array;
  sendCounter: bigint;
  recvCounter: bigint;
}

export class AeadChannel {
  private sendCounter = 0n;
  private recvCounter = 0n;
  private destroyed = false;

  private constructor(private readonly keys: SessionKeys) {}

  static async of(encryptionKeyBytes: Uint8Array, sessionId: string): Promise<AeadChannel> {
    // Keep an owned copy so callers can zeroize their buffer independently.
    const owned = encryptionKeyBytes.slice();
    const encryptionKey = await importAesGcmKey(owned);
    return new AeadChannel({
      encryptionKeyBytes: owned,
      encryptionKey,
      sessionId,
    });
  }

  /**
   * Restore a channel after hibernation. Counters must match the peer or
   * AEAD will reject (replay / wrong counter).
   */
  static async restore(snapshot: AeadChannelSnapshot): Promise<AeadChannel> {
    const channel = await AeadChannel.of(snapshot.encryptionKeyBytes, snapshot.sessionId);
    channel.sendCounter = snapshot.sendCounter;
    channel.recvCounter = snapshot.recvCounter;
    return channel;
  }

  get sessionId(): string {
    return this.keys.sessionId;
  }

  get isDestroyed(): boolean {
    return this.destroyed;
  }

  /** Snapshot for Durable Object attachment / durable storage (secret!). */
  exportSnapshot(): AeadChannelSnapshot {
    this.assertLive();
    return {
      sessionId: this.keys.sessionId,
      encryptionKeyBytes: this.keys.encryptionKeyBytes.slice(),
      sendCounter: this.sendCounter,
      recvCounter: this.recvCounter,
    };
  }

  private assertLive(): void {
    if (this.destroyed) throw new AeadError('AeadChannel has been destroyed');
  }

  private aad(counter: bigint, kind: FrameKind): Uint8Array {
    return concatBytes(
      new TextEncoder().encode(this.keys.sessionId),
      u64Be(counter),
      kindByte(kind),
    );
  }

  /**
   * Seal plaintext bytes for a specific frame kind.
   * Returns counter + base64url(iv ‖ ciphertext‖tag).
   */
  async seal(
    plaintext: Uint8Array,
    kind: FrameKind,
  ): Promise<{ counter: bigint; ciphertextB64: string; kind: FrameKind }> {
    this.assertLive();
    const counter = this.sendCounter++;
    const nonce = randomBytes(NONCE_BYTES);
    const ciphertext = new Uint8Array(
      await subtle.encrypt(
        {
          name: 'AES-GCM',
          iv: buf(nonce),
          additionalData: buf(this.aad(counter, kind)),
        },
        this.keys.encryptionKey,
        buf(plaintext),
      ),
    );
    return {
      counter,
      kind,
      ciphertextB64: base64UrlEncode(concatBytes(nonce, ciphertext)),
    };
  }

  /**
   * Open a sealed payload. Kind is authenticated via AAD — wrong kind fails decrypt.
   */
  async open(
    counter: bigint | number,
    ciphertextB64: string,
    kind: FrameKind,
  ): Promise<Uint8Array> {
    this.assertLive();
    const c = typeof counter === 'bigint' ? counter : BigInt(counter);
    if (c < this.recvCounter) {
      throw new AeadError('Replay or out-of-order counter');
    }

    let raw: Uint8Array;
    try {
      raw = base64UrlDecode(ciphertextB64);
    } catch {
      throw new AeadError('Malformed ciphertext encoding');
    }
    if (raw.length <= NONCE_BYTES) throw new AeadError('Ciphertext too short');

    try {
      const plaintext = await subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: buf(raw.subarray(0, NONCE_BYTES)),
          additionalData: buf(this.aad(c, kind)),
        },
        this.keys.encryptionKey,
        buf(raw.subarray(NONCE_BYTES)),
      );
      this.recvCounter = c + 1n;
      return new Uint8Array(plaintext);
    } catch {
      throw new AeadError('Decryption failed (tamper, wrong key, wrong kind, or wrong AAD)');
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    zeroize(this.keys.encryptionKeyBytes);
  }
}
