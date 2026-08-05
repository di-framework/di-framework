import {
  binaryFrame,
  isSocketFrame,
  type SendInput,
  type SendOptions,
  type SocketFrame,
  textFrame,
  toFrame,
} from '../core/frame.ts';
import { AeadChannel } from './aead.ts';
import { base64UrlDecode, base64UrlEncode } from './bytes.ts';
import { HandshakeError, SecureHandshakeConsumer, SecureHandshakeProvider } from './handshake.ts';
import { encodeProtocolMessage, type ProtocolMessage, parseProtocolMessage } from './protocol.ts';
import {
  decodeSealedBinary,
  encodeSealedBinary,
  encodeSealedJson,
  frameFromOpened,
  tryParseSealedJson,
} from './sealed-wire.ts';

/**
 * Duplex that preserves frame kind.
 *
 * Handshake uses **text** frames (JSON). Sealed application data prefers
 * **binary** frames (compact sealed wire); JSON sealed on text is still accepted.
 */
export interface MessageDuplex {
  send(frame: SocketFrame): void | Promise<void>;
  onMessage(handler: (frame: SocketFrame) => void): () => void;
  close?(code?: number, reason?: string): void;
}

export type HandshakeRole = 'provider' | 'consumer';

export interface SecureSessionOptions {
  role: HandshakeRole;
  duplex: MessageDuplex;
  requireSecure?: boolean;
}

export type SecureSessionState = 'handshaking' | 'open' | 'closed' | 'failed';

/**
 * JSON-safe snapshot of an open secure session for Durable Object hibernation.
 *
 * **Secret material:** `key` is the raw AES-256 key (base64url). Prefer DO
 * storage over large attachments when possible; never log this object.
 */
export interface SecureSessionSnapshot {
  v: 1;
  sessionId: string;
  /** base64url AES-256 key */
  key: string;
  sendCounter: string;
  recvCounter: string;
}

/**
 * Runs the secure handshake over a duplex, then AEAD-seals application payloads
 * while preserving text vs binary frame kind.
 */
export class SecureSession {
  private state: SecureSessionState = 'handshaking';
  private channel: AeadChannel | null = null;
  private provider: SecureHandshakeProvider | null = null;
  private consumer: SecureHandshakeConsumer | null = null;
  private unsub: (() => void) | null = null;
  private readonly dataHandlers = new Set<(frame: SocketFrame) => void>();
  private openResolve: ((session: SecureSession) => void) | null = null;
  private openReject: ((err: Error) => void) | null = null;
  private openPromise: Promise<SecureSession>;

  private constructor(private readonly options: SecureSessionOptions) {
    this.openPromise = new Promise<SecureSession>((resolve, reject) => {
      this.openResolve = resolve;
      this.openReject = reject;
    });
  }

  static async connect(options: SecureSessionOptions): Promise<SecureSession> {
    const session = new SecureSession(options);
    await session.begin();
    return session.whenOpen();
  }

  /**
   * Rebuild an open session after hibernation without a new handshake.
   * Peer counters must still be in sync (use immediately after wake).
   */
  static async rehydrate(options: {
    duplex: MessageDuplex;
    snapshot: SecureSessionSnapshot;
  }): Promise<SecureSession> {
    if (options.snapshot.v !== 1) {
      throw new HandshakeError('Unsupported session snapshot version', 'bad_snapshot');
    }
    const session = new SecureSession({
      role: 'provider', // role unused once open
      duplex: options.duplex,
    });
    const keyBytes = base64UrlDecode(options.snapshot.key);
    session.channel = await AeadChannel.restore({
      sessionId: options.snapshot.sessionId,
      encryptionKeyBytes: keyBytes,
      sendCounter: BigInt(options.snapshot.sendCounter),
      recvCounter: BigInt(options.snapshot.recvCounter),
    });
    session.state = 'open';
    session.unsub = options.duplex.onMessage((frame) => {
      void session.onFrame(frame).catch((err) => session.fail(err));
    });
    // Resolve open promise so whenOpen() works
    session.openResolve?.(session);
    session.openResolve = null;
    session.openReject = null;
    return session;
  }

  whenOpen(): Promise<SecureSession> {
    return this.openPromise;
  }

  getState(): SecureSessionState {
    return this.state;
  }

  get sessionId(): string | null {
    return (
      this.channel?.sessionId ??
      this.provider?.getSessionId() ??
      this.consumer?.getSessionId() ??
      null
    );
  }

  onData(handler: (frame: SocketFrame) => void): () => void {
    this.dataHandlers.add(handler);
    return () => this.dataHandlers.delete(handler);
  }

  /**
   * Export open-session state for Durable Object `serializeAttachment` / storage.
   * @throws if not open
   */
  exportSnapshot(): SecureSessionSnapshot {
    if (this.state !== 'open' || !this.channel) {
      throw new HandshakeError('Session not open', 'not_open');
    }
    const aead = this.channel.exportSnapshot();
    return {
      v: 1,
      sessionId: aead.sessionId,
      key: base64UrlEncode(aead.encryptionKeyBytes),
      sendCounter: aead.sendCounter.toString(),
      recvCounter: aead.recvCounter.toString(),
    };
  }

  async send(input: SendInput, options?: SendOptions): Promise<void> {
    if (this.state !== 'open' || !this.channel) {
      throw new HandshakeError('Session not open', 'not_open');
    }
    const frame = isSocketFrame(input) ? input : toFrame(input, options);
    const { counter, ciphertextB64, kind } = await this.channel.seal(frame.data, frame.kind);
    const sealedBody = base64UrlDecode(ciphertextB64);

    // Prefer binary WebSocket frames for sealed traffic (handshake stays text).
    const wire = encodeSealedBinary({ kind, counter, sealedBody });
    await this.options.duplex.send(binaryFrame(wire));
  }

  /** Escape hatch: send sealed payload as a text JSON envelope (still carries kind). */
  async sendSealedText(input: SendInput, options?: SendOptions): Promise<void> {
    if (this.state !== 'open' || !this.channel) {
      throw new HandshakeError('Session not open', 'not_open');
    }
    const frame = isSocketFrame(input) ? input : toFrame(input, options);
    const { counter, ciphertextB64, kind } = await this.channel.seal(frame.data, frame.kind);
    const sealedBody = base64UrlDecode(ciphertextB64);
    const json = encodeSealedJson({
      sessionId: this.channel.sessionId,
      kind,
      counter,
      sealedBody,
    });
    await this.options.duplex.send(textFrame(json));
  }

  /**
   * Tear down crypto state.
   * @param options.closeTransport - also close the underlying duplex (default true).
   *   Pass false when replacing a session on a still-open DO WebSocket.
   */
  close(options?: { closeTransport?: boolean }): void {
    if (this.state === 'closed') return;
    this.state = 'closed';
    this.unsub?.();
    this.unsub = null;
    this.channel?.destroy();
    this.channel = null;
    this.provider?.destroy();
    this.consumer?.destroy();
    this.provider = null;
    this.consumer = null;
    if (options?.closeTransport !== false) {
      this.options.duplex.close?.();
    }
  }

  private async begin(): Promise<void> {
    this.unsub = this.options.duplex.onMessage((frame) => {
      void this.onFrame(frame).catch((err) => this.fail(err));
    });

    if (this.options.role === 'provider') {
      this.provider = await SecureHandshakeProvider.create();
      await Promise.resolve();
      if (this.state === 'handshaking' && this.provider) {
        await this.options.duplex.send(textFrame(encodeProtocolMessage(this.provider.start())));
      }
    } else {
      this.consumer = await SecureHandshakeConsumer.create();
    }
  }

  private async onFrame(frame: SocketFrame): Promise<void> {
    if (this.state === 'closed' || this.state === 'failed') return;

    if (this.state === 'open' && this.channel) {
      await this.onSealedFrame(frame);
      return;
    }

    // Handshake: only text frames with JSON protocol messages.
    if (frame.kind !== 'text' || frame.text === undefined) {
      if (this.state === 'handshaking') {
        // Ignore binary noise during handshake (e.g. UDP knock is binary empty).
        if (frame.data.length === 0) return;
        throw new HandshakeError('Handshake requires text frames', 'wrong_frame_kind');
      }
      return;
    }

    let message: ProtocolMessage;
    try {
      message = parseProtocolMessage(frame.text);
    } catch {
      return;
    }

    if (message.type === 'di-socket/error') {
      throw new HandshakeError(message.message, message.code);
    }

    if (this.options.role === 'provider' && this.provider) {
      if (message.type === 'di-socket/handshake-response') {
        const confReq = await this.provider.handleResponse(message);
        await this.options.duplex.send(textFrame(encodeProtocolMessage(confReq)));
        return;
      }
      if (message.type === 'di-socket/key-confirmation') {
        await this.provider.handleConfirmation(message);
        await this.finishOpen(this.provider.exportKeys());
        return;
      }
    }

    if (this.options.role === 'consumer' && this.consumer) {
      if (message.type === 'di-socket/handshake-init') {
        const response = await this.consumer.handleInit(message);
        await this.options.duplex.send(textFrame(encodeProtocolMessage(response)));
        return;
      }
      if (message.type === 'di-socket/key-confirmation-request') {
        const conf = await this.consumer.handleConfirmationRequest(message);
        await this.options.duplex.send(textFrame(encodeProtocolMessage(conf)));
        await this.finishOpen(this.consumer.exportKeys());
        return;
      }
    }
  }

  private async onSealedFrame(frame: SocketFrame): Promise<void> {
    if (!this.channel) return;

    if (frame.kind === 'binary') {
      const decoded = decodeSealedBinary(frame.data);
      const b64 = base64UrlEncode(decoded.sealedBody);
      const plain = await this.channel.open(decoded.counter, b64, decoded.kind);
      const app = frameFromOpened(decoded.kind, plain);
      for (const h of this.dataHandlers) h(app);
      return;
    }

    // Text path: JSON sealed envelope
    if (frame.text) {
      const sealed = tryParseSealedJson(frame.text);
      if (!sealed) {
        throw new HandshakeError('Expected sealed application frame', 'invalid_message');
      }
      if (sealed.sessionId !== this.channel.sessionId) {
        throw new HandshakeError('Session ID mismatch on sealed frame', 'session_mismatch');
      }
      const b64 = base64UrlEncode(sealed.sealedBody);
      const plain = await this.channel.open(sealed.counter, b64, sealed.kind);
      const app = frameFromOpened(sealed.kind, plain);
      for (const h of this.dataHandlers) h(app);
      return;
    }

    throw new HandshakeError('Empty sealed text frame', 'invalid_message');
  }

  private async finishOpen(material: {
    sessionId: string;
    encryptionKeyBytes: Uint8Array;
  }): Promise<void> {
    this.channel = await AeadChannel.of(material.encryptionKeyBytes, material.sessionId);
    this.state = 'open';
    this.openResolve?.(this);
    this.openResolve = null;
    this.openReject = null;
  }

  private fail(err: unknown): void {
    if (this.state === 'failed' || this.state === 'closed') return;
    this.state = 'failed';
    const error = err instanceof Error ? err : new Error(String(err));
    this.openReject?.(error);
    this.openResolve = null;
    this.openReject = null;
    this.channel?.destroy();
    this.provider?.destroy();
    this.consumer?.destroy();
    this.unsub?.();
  }
}
