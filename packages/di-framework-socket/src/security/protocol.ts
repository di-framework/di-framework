/** Wire protocol version for the secure handshake. */
export const PROTOCOL_VERSION = 1 as const;

/** Only suite supported in v1. */
export const SUITE_V1 = 'ECDH-P-256+HKDF-SHA-256+AES-256-GCM' as const;

export type SecurityMode = 'secure' | 'plain';

export type HandshakeMessageType =
  | 'di-socket/handshake-init'
  | 'di-socket/handshake-response'
  | 'di-socket/key-confirmation-request'
  | 'di-socket/key-confirmation'
  | 'di-socket/sealed'
  | 'di-socket/error';

export interface HandshakeInit {
  type: 'di-socket/handshake-init';
  version: typeof PROTOCOL_VERSION;
  sessionId: string;
  publicKey: string;
  providerNonce: string;
  supportedSuites: readonly string[];
}

export interface HandshakeResponse {
  type: 'di-socket/handshake-response';
  version: typeof PROTOCOL_VERSION;
  sessionId: string;
  publicKey: string;
  consumerNonce: string;
  selectedSuite: string;
}

export interface KeyConfirmationRequest {
  type: 'di-socket/key-confirmation-request';
  sessionId: string;
  confirmationMac: string;
}

export interface KeyConfirmation {
  type: 'di-socket/key-confirmation';
  sessionId: string;
  publicKey: string;
  confirmationMac: string;
}

/** JSON sealed envelope on a text frame (includes application frame kind). */
export interface SealedMessage {
  type: 'di-socket/sealed';
  sessionId: string;
  /** Original application frame kind (text | binary). */
  kind: 'text' | 'binary';
  counter: string;
  payload: string;
}

export interface ProtocolErrorMessage {
  type: 'di-socket/error';
  code: string;
  message: string;
}

export type ProtocolMessage =
  | HandshakeInit
  | HandshakeResponse
  | KeyConfirmationRequest
  | KeyConfirmation
  | SealedMessage
  | ProtocolErrorMessage;

export function isProtocolMessage(value: unknown): value is ProtocolMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    typeof (value as { type: unknown }).type === 'string' &&
    String((value as { type: string }).type).startsWith('di-socket/')
  );
}

export function parseProtocolMessage(raw: string | Uint8Array): ProtocolMessage {
  const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Invalid protocol message: not JSON');
  }
  if (!isProtocolMessage(parsed)) {
    throw new Error('Invalid protocol message: missing di-socket type');
  }
  return parsed;
}

export function encodeProtocolMessage(message: ProtocolMessage): string {
  return JSON.stringify(message);
}
