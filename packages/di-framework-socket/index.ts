// Decorators (primary API — matches @Controller / @EventBridge)
export {
  OnClose,
  OnConnect,
  OnError,
  OnMessage,
  SocketGateway,
  startSocketGateways,
  stopSocketGateways,
} from './src/decorators.ts';
export type {
  OnMessageDecoratorOptions,
  SocketGatewayDecoratorOptions,
  SocketGatewayHandle,
  SocketListenFactory,
} from './src/types.ts';
export {
  default as socketRegistry,
  getRegistry as getSocketRegistry,
  setRegistry as setSocketRegistry,
  SocketGatewayRegistry,
  type SocketGatewayEntry,
  type SocketHandlerMeta,
} from './src/registry.ts';

// Frames (text vs binary — first-class)
export {
  binaryFrame,
  isSocketFrame,
  textFrame,
  toFrame,
  type FrameKind,
  type SendInput,
  type SendOptions,
  type SocketFrame,
} from './src/core/frame.ts';

// Core contracts
export {
  type CreateServerOptions,
  type MessageHandler,
  type MessageMeta,
  type PeerAddress,
  type RuntimeName,
  type SocketConnection,
  type SocketProtocol,
  type SocketServer,
  SocketCapabilityError,
} from './src/core/types.ts';
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

// Security (used under the hood; available for custom listen factories)
export { AeadChannel, AeadError, type SessionKeys, importAesGcmKey } from './src/security/aead.ts';
export {
  type DerivedSessionMaterial,
  HandshakeError,
  runHandshakePair,
  SecureHandshakeConsumer,
  SecureHandshakeProvider,
} from './src/security/handshake.ts';
export {
  encodeProtocolMessage,
  isProtocolMessage,
  parseProtocolMessage,
  PROTOCOL_VERSION,
  type HandshakeInit,
  type HandshakeMessageType,
  type HandshakeResponse,
  type KeyConfirmation,
  type KeyConfirmationRequest,
  type ProtocolErrorMessage,
  type ProtocolMessage,
  type SealedMessage,
  type SecurityMode,
  SUITE_V1,
} from './src/security/protocol.ts';
export {
  type HandshakeRole,
  type MessageDuplex,
  type SecureSessionOptions,
  type SecureSessionSnapshot,
  type SecureSessionState,
  SecureSession,
} from './src/security/session.ts';
export type { AeadChannelSnapshot } from './src/security/aead.ts';
export { hkdf, SOCKET_KDF_LABELS, type SocketKdfLabel } from './src/security/kdf.ts';
export { timingSafeEqual } from './src/security/compare.ts';
export {
  base64UrlDecode,
  base64UrlEncode,
  concatBytes,
  randomBytes,
  zeroize,
} from './src/security/bytes.ts';
