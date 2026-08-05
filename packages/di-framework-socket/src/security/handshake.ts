import {
  base64UrlDecode,
  base64UrlEncode,
  concatBytes,
  randomBytes,
  zeroize,
} from './bytes.ts';
import { timingSafeEqual } from './compare.ts';
import { deriveSharedSecret, generateEcdhKeyPair, importEcdhPublicKey } from './ecdh.ts';
import { hkdf, SOCKET_KDF_LABELS } from './kdf.ts';
import {
  type HandshakeInit,
  type HandshakeResponse,
  type KeyConfirmation,
  type KeyConfirmationRequest,
  PROTOCOL_VERSION,
  SUITE_V1,
} from './protocol.ts';
import { buf, subtle } from './webcrypto.ts';

export class HandshakeError extends Error {
  override readonly name = 'HandshakeError';
  constructor(
    message: string,
    readonly code: string = 'handshake_failed',
  ) {
    super(message);
  }
}

export interface DerivedSessionMaterial {
  sessionId: string;
  encryptionKeyBytes: Uint8Array;
}

interface InternalKeys {
  encryptionKeyBytes: Uint8Array;
  confirmationKeyBytes: Uint8Array;
}

async function hmacSha256(keyBytes: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const key = await subtle.importKey(
    'raw',
    buf(keyBytes),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await subtle.sign('HMAC', key, buf(data)));
}

async function deriveSessionKeys(
  sharedSecret: Uint8Array,
  providerNonce: Uint8Array,
  consumerNonce: Uint8Array,
): Promise<InternalKeys> {
  const salt = concatBytes(providerNonce, consumerNonce);
  const encryptionKeyBytes = await hkdf(sharedSecret, salt, SOCKET_KDF_LABELS.encryption, 32);
  const confirmationKeyBytes = await hkdf(sharedSecret, salt, SOCKET_KDF_LABELS.confirmation, 32);
  return { encryptionKeyBytes, confirmationKeyBytes };
}

/**
 * Provider (typically the server) side of the secure handshake.
 *
 * Flow: start() → handleResponse(handshake-response) → handleConfirmation(key-confirmation)
 */
export class SecureHandshakeProvider {
  private keyPair: Awaited<ReturnType<typeof generateEcdhKeyPair>> | null = null;
  private sessionId = '';
  private providerNonce: Uint8Array | null = null;
  private consumerNonce: Uint8Array | null = null;
  private consumerPublicKeyB64: string | null = null;
  private sharedSecret: Uint8Array | null = null;
  private keys: InternalKeys | null = null;
  private confirmed = false;
  private destroyed = false;

  static async create(): Promise<SecureHandshakeProvider> {
    const p = new SecureHandshakeProvider();
    p.keyPair = await generateEcdhKeyPair();
    p.sessionId = base64UrlEncode(randomBytes(16));
    p.providerNonce = randomBytes(32);
    return p;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  isConfirmed(): boolean {
    return this.confirmed;
  }

  /** First message: advertise ephemeral public key and nonce. */
  start(): HandshakeInit {
    this.assertLive();
    if (!this.keyPair || !this.providerNonce) throw new HandshakeError('Not initialized');
    return {
      type: 'di-socket/handshake-init',
      version: PROTOCOL_VERSION,
      sessionId: this.sessionId,
      publicKey: this.keyPair.publicKeyB64,
      providerNonce: base64UrlEncode(this.providerNonce),
      supportedSuites: [SUITE_V1],
    };
  }

  /**
   * Process consumer handshake-response. Returns key-confirmation-request to send.
   */
  async handleResponse(message: HandshakeResponse): Promise<KeyConfirmationRequest> {
    this.assertLive();
    if (!this.keyPair || !this.providerNonce) throw new HandshakeError('Not initialized');
    if (message.type !== 'di-socket/handshake-response') {
      throw new HandshakeError('Expected handshake-response', 'unexpected_message');
    }
    if (message.version !== PROTOCOL_VERSION) {
      throw new HandshakeError('Unsupported protocol version', 'version_mismatch');
    }
    if (message.sessionId !== this.sessionId) {
      throw new HandshakeError('Session ID mismatch', 'session_mismatch');
    }
    if (message.selectedSuite !== SUITE_V1) {
      throw new HandshakeError('Unsupported suite', 'suite_mismatch');
    }

    this.consumerNonce = base64UrlDecode(message.consumerNonce);
    this.consumerPublicKeyB64 = message.publicKey;
    const peer = await importEcdhPublicKey(message.publicKey);
    this.sharedSecret = await deriveSharedSecret(this.keyPair.privateKey, peer);
    this.keys = await deriveSessionKeys(this.sharedSecret, this.providerNonce, this.consumerNonce);

    const mac = await hmacSha256(
      this.keys.confirmationKeyBytes,
      this.providerConfirmationTranscript(),
    );

    return {
      type: 'di-socket/key-confirmation-request',
      sessionId: this.sessionId,
      confirmationMac: base64UrlEncode(mac),
    };
  }

  /**
   * Verify consumer's key-confirmation. On success the session is confirmed.
   */
  async handleConfirmation(message: KeyConfirmation): Promise<void> {
    this.assertLive();
    if (!this.keys || !this.consumerPublicKeyB64 || !this.keyPair) {
      throw new HandshakeError('Handshake incomplete', 'premature_confirmation');
    }
    if (message.type !== 'di-socket/key-confirmation') {
      throw new HandshakeError('Expected key-confirmation', 'unexpected_message');
    }
    if (message.sessionId !== this.sessionId) {
      throw new HandshakeError('Session ID mismatch', 'session_mismatch');
    }
    if (message.publicKey !== this.consumerPublicKeyB64) {
      throw new HandshakeError('Public key mismatch', 'pubkey_mismatch');
    }

    const expected = await hmacSha256(
      this.keys.confirmationKeyBytes,
      this.consumerConfirmationTranscript(),
    );
    const received = base64UrlDecode(message.confirmationMac);
    if (!(await timingSafeEqual(expected, received))) {
      throw new HandshakeError('Key confirmation failed — possible MITM', 'confirmation_failed');
    }
    this.confirmed = true;
  }

  /** Export encryption key material only after confirmation. */
  exportKeys(): DerivedSessionMaterial {
    if (!this.confirmed || !this.keys) {
      throw new HandshakeError('Handshake not confirmed', 'not_confirmed');
    }
    // Return a copy so caller destroy and provider destroy are independent.
    return {
      sessionId: this.sessionId,
      encryptionKeyBytes: this.keys.encryptionKeyBytes.slice(),
    };
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    zeroize(this.providerNonce);
    zeroize(this.consumerNonce);
    zeroize(this.sharedSecret);
    if (this.keys) {
      zeroize(this.keys.encryptionKeyBytes);
      zeroize(this.keys.confirmationKeyBytes);
      this.keys = null;
    }
    this.confirmed = false;
  }

  private providerConfirmationTranscript(): Uint8Array {
    if (!this.providerNonce || !this.consumerNonce || !this.keyPair || !this.consumerPublicKeyB64) {
      throw new HandshakeError('Missing transcript material');
    }
    return concatBytes(
      this.providerNonce,
      this.consumerNonce,
      base64UrlDecode(this.keyPair.publicKeyB64),
      base64UrlDecode(this.consumerPublicKeyB64),
      new TextEncoder().encode(this.sessionId),
    );
  }

  private consumerConfirmationTranscript(): Uint8Array {
    if (!this.providerNonce || !this.consumerNonce || !this.keyPair || !this.consumerPublicKeyB64) {
      throw new HandshakeError('Missing transcript material');
    }
    return concatBytes(
      this.consumerNonce,
      this.providerNonce,
      base64UrlDecode(this.consumerPublicKeyB64),
      base64UrlDecode(this.keyPair.publicKeyB64),
      new TextEncoder().encode(this.sessionId),
    );
  }

  private assertLive(): void {
    if (this.destroyed) throw new HandshakeError('Handshake destroyed', 'destroyed');
  }
}

/**
 * Consumer (typically the client) side of the secure handshake.
 *
 * Flow: handleInit(handshake-init) → handleConfirmationRequest(key-confirmation-request)
 */
export class SecureHandshakeConsumer {
  private keyPair: Awaited<ReturnType<typeof generateEcdhKeyPair>> | null = null;
  private sessionId: string | null = null;
  private providerNonce: Uint8Array | null = null;
  private consumerNonce: Uint8Array | null = null;
  private providerPublicKeyB64: string | null = null;
  private sharedSecret: Uint8Array | null = null;
  private keys: InternalKeys | null = null;
  private confirmed = false;
  private destroyed = false;

  static async create(): Promise<SecureHandshakeConsumer> {
    const c = new SecureHandshakeConsumer();
    c.keyPair = await generateEcdhKeyPair();
    c.consumerNonce = randomBytes(32);
    return c;
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  isConfirmed(): boolean {
    return this.confirmed;
  }

  /** Process handshake-init; returns handshake-response to send. */
  async handleInit(message: HandshakeInit): Promise<HandshakeResponse> {
    this.assertLive();
    if (!this.keyPair || !this.consumerNonce) throw new HandshakeError('Not initialized');
    if (message.type !== 'di-socket/handshake-init') {
      throw new HandshakeError('Expected handshake-init', 'unexpected_message');
    }
    if (message.version !== PROTOCOL_VERSION) {
      throw new HandshakeError('Unsupported protocol version', 'version_mismatch');
    }
    if (!message.supportedSuites?.includes(SUITE_V1)) {
      throw new HandshakeError('No mutually supported suite', 'suite_mismatch');
    }

    this.sessionId = message.sessionId;
    this.providerNonce = base64UrlDecode(message.providerNonce);
    this.providerPublicKeyB64 = message.publicKey;
    const peer = await importEcdhPublicKey(message.publicKey);
    this.sharedSecret = await deriveSharedSecret(this.keyPair.privateKey, peer);
    this.keys = await deriveSessionKeys(this.sharedSecret, this.providerNonce, this.consumerNonce);

    return {
      type: 'di-socket/handshake-response',
      version: PROTOCOL_VERSION,
      sessionId: this.sessionId,
      publicKey: this.keyPair.publicKeyB64,
      consumerNonce: base64UrlEncode(this.consumerNonce),
      selectedSuite: SUITE_V1,
    };
  }

  /**
   * Verify provider confirmation MAC and produce consumer key-confirmation.
   */
  async handleConfirmationRequest(message: KeyConfirmationRequest): Promise<KeyConfirmation> {
    this.assertLive();
    if (
      !this.keys ||
      !this.keyPair ||
      !this.sessionId ||
      !this.providerPublicKeyB64 ||
      !this.providerNonce ||
      !this.consumerNonce
    ) {
      throw new HandshakeError('Handshake incomplete', 'premature_confirmation');
    }
    if (message.type !== 'di-socket/key-confirmation-request') {
      throw new HandshakeError('Expected key-confirmation-request', 'unexpected_message');
    }
    if (message.sessionId !== this.sessionId) {
      throw new HandshakeError('Session ID mismatch', 'session_mismatch');
    }

    const expected = await hmacSha256(
      this.keys.confirmationKeyBytes,
      this.providerConfirmationTranscript(),
    );
    const received = base64UrlDecode(message.confirmationMac);
    if (!(await timingSafeEqual(expected, received))) {
      throw new HandshakeError(
        'Provider key confirmation failed — possible MITM',
        'confirmation_failed',
      );
    }

    const ourMac = await hmacSha256(
      this.keys.confirmationKeyBytes,
      this.consumerConfirmationTranscript(),
    );
    this.confirmed = true;

    return {
      type: 'di-socket/key-confirmation',
      sessionId: this.sessionId,
      publicKey: this.keyPair.publicKeyB64,
      confirmationMac: base64UrlEncode(ourMac),
    };
  }

  exportKeys(): DerivedSessionMaterial {
    if (!this.confirmed || !this.keys || !this.sessionId) {
      throw new HandshakeError('Handshake not confirmed', 'not_confirmed');
    }
    return {
      sessionId: this.sessionId,
      encryptionKeyBytes: this.keys.encryptionKeyBytes.slice(),
    };
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    zeroize(this.providerNonce);
    zeroize(this.consumerNonce);
    zeroize(this.sharedSecret);
    if (this.keys) {
      zeroize(this.keys.encryptionKeyBytes);
      zeroize(this.keys.confirmationKeyBytes);
      this.keys = null;
    }
    this.confirmed = false;
  }

  private providerConfirmationTranscript(): Uint8Array {
    if (!this.providerNonce || !this.consumerNonce || !this.keyPair || !this.providerPublicKeyB64) {
      throw new HandshakeError('Missing transcript material');
    }
    return concatBytes(
      this.providerNonce,
      this.consumerNonce,
      base64UrlDecode(this.providerPublicKeyB64),
      base64UrlDecode(this.keyPair.publicKeyB64),
      new TextEncoder().encode(this.sessionId!),
    );
  }

  private consumerConfirmationTranscript(): Uint8Array {
    if (!this.providerNonce || !this.consumerNonce || !this.keyPair || !this.providerPublicKeyB64) {
      throw new HandshakeError('Missing transcript material');
    }
    return concatBytes(
      this.consumerNonce,
      this.providerNonce,
      base64UrlDecode(this.keyPair.publicKeyB64),
      base64UrlDecode(this.providerPublicKeyB64),
      new TextEncoder().encode(this.sessionId!),
    );
  }

  private assertLive(): void {
    if (this.destroyed) throw new HandshakeError('Handshake destroyed', 'destroyed');
  }
}

/** Drive a full handshake over two in-memory message queues (test helper). */
export async function runHandshakePair(): Promise<{
  provider: SecureHandshakeProvider;
  consumer: SecureHandshakeConsumer;
  providerMaterial: DerivedSessionMaterial;
  consumerMaterial: DerivedSessionMaterial;
}> {
  const provider = await SecureHandshakeProvider.create();
  const consumer = await SecureHandshakeConsumer.create();

  const init = provider.start();
  const response = await consumer.handleInit(init);
  const confReq = await provider.handleResponse(response);
  const conf = await consumer.handleConfirmationRequest(confReq);
  await provider.handleConfirmation(conf);

  return {
    provider,
    consumer,
    providerMaterial: provider.exportKeys(),
    consumerMaterial: consumer.exportKeys(),
  };
}
