// Decorators (primary API — matches @Controller / @EventBridge)

// Frames (text vs binary — first-class)
export {
  binaryFrame,
  type FrameKind,
  isSocketFrame,
  type SendInput,
  type SendOptions,
  type SocketFrame,
  textFrame,
  toFrame,
} from './src/core/frame.ts';
export {
  decodeUdpEnvelope,
  encodeLengthPrefix,
  encodeUdpEnvelope,
  FramingError,
  LengthPrefixFramer,
  UDP_ENVELOPE_VERSION,
  UDP_MAGIC,
} from './src/core/framing.ts';
export { createMemoryDuplexPair } from './src/core/memory-duplex.ts';
// Core contracts
export {
  type CreateServerOptions,
  type MessageHandler,
  type MessageMeta,
  type PeerAddress,
  type RuntimeName,
  SocketCapabilityError,
  type SocketConnection,
  type SocketProtocol,
  type SocketServer,
} from './src/core/types.ts';
export {
  OnClose,
  OnConnect,
  OnError,
  OnMessage,
  SocketGateway,
  startSocketGateways,
  stopSocketGateways,
} from './src/decorators.ts';
export {
  default as socketRegistry,
  getRegistry as getSocketRegistry,
  type SocketGatewayEntry,
  SocketGatewayRegistry,
  type SocketHandlerMeta,
  setRegistry as setSocketRegistry,
} from './src/registry.ts';
export type { AeadChannelSnapshot } from './src/security/aead.ts';

// Security (used under the hood; available for custom listen factories)
export { AeadChannel, AeadError, importAesGcmKey, type SessionKeys } from './src/security/aead.ts';
export {
  base64UrlDecode,
  base64UrlEncode,
  concatBytes,
  randomBytes,
  zeroize,
} from './src/security/bytes.ts';
export { timingSafeEqual } from './src/security/compare.ts';
export {
  type DerivedSessionMaterial,
  HandshakeError,
  runHandshakePair,
  SecureHandshakeConsumer,
  SecureHandshakeProvider,
} from './src/security/handshake.ts';
export { hkdf, SOCKET_KDF_LABELS, type SocketKdfLabel } from './src/security/kdf.ts';
export {
  encodeProtocolMessage,
  type HandshakeInit,
  type HandshakeMessageType,
  type HandshakeResponse,
  isProtocolMessage,
  type KeyConfirmation,
  type KeyConfirmationRequest,
  PROTOCOL_VERSION,
  type ProtocolErrorMessage,
  type ProtocolMessage,
  parseProtocolMessage,
  type SealedMessage,
  type SecurityMode,
  SUITE_V1,
} from './src/security/protocol.ts';
export {
  type HandshakeRole,
  type MessageDuplex,
  SecureSession,
  type SecureSessionOptions,
  type SecureSessionSnapshot,
  type SecureSessionState,
} from './src/security/session.ts';
export type {
  OnMessageDecoratorOptions,
  SocketGatewayDecoratorOptions,
  SocketGatewayHandle,
  SocketListenFactory,
} from './src/types.ts';
