import { createSocket, type RemoteInfo, type Socket as UdpSocket } from 'node:dgram';
import { binaryFrame, type SocketFrame } from '../core/frame.ts';
import { decodeUdpEnvelope, encodeUdpEnvelope } from '../core/framing.ts';
import type { CreateServerOptions, SocketConnection, SocketServer } from '../core/types.ts';
import type { SecurityMode } from '../security/protocol.ts';
import { type MessageDuplex, SecureSession } from '../security/session.ts';
import { connectionFromSecureSession, createPlainConnection } from './connection-helpers.ts';

export interface NodeUdpSocketOptions extends CreateServerOptions {
  port?: number;
  hostname?: string;
}

export interface NodeUdpClientOptions {
  hostname: string;
  port: number;
  security?: { mode?: SecurityMode };
  localHostname?: string;
  localPort?: number;
}

function peerKey(address: string, port: number): string {
  return `${address}:${port}`;
}

const KNOCK_SESSION = 'knock';

/**
 * UDP socket on `node:dgram` with kind-preserving envelopes.
 * Works on Node and Bun via Node compatibility.
 */
export async function createUdpSocket(options: NodeUdpSocketOptions = {}): Promise<
  SocketServer & {
    readonly port: number;
    readonly hostname: string;
    sendTo(
      payload: SocketFrame | Uint8Array | string,
      port: number,
      address: string,
      sessionId?: string,
    ): void;
  }
> {
  const mode: SecurityMode = options.security?.mode ?? 'secure';
  const hostname = options.hostname ?? '127.0.0.1';

  type PeerState = {
    handlers: Set<(frame: SocketFrame) => void>;
    seq: bigint;
    session?: SecureSession;
    connection?: SocketConnection;
    plain?: ReturnType<typeof createPlainConnection>;
  };

  const peers = new Map<string, PeerState>();
  let seq = 0n;

  const udp = createSocket('udp4');

  await new Promise<void>((resolve, reject) => {
    udp.once('error', reject);
    udp.bind(options.port ?? 0, hostname, () => {
      udp.off('error', reject);
      resolve();
    });
  });

  async function ensurePeer(port: number, address: string): Promise<PeerState> {
    const key = peerKey(address, port);
    const existing = peers.get(key);
    if (existing) return existing;

    const peer: PeerState = { handlers: new Set(), seq: 0n };
    peers.set(key, peer);

    if (mode === 'plain') {
      const plain = createPlainConnection({
        protocol: 'udp',
        mode,
        id: key,
        send(frame) {
          const wire = encodeUdpEnvelope('plain', ++seq, frame);
          udp.send(Buffer.from(wire), port, address);
        },
        close() {
          peers.delete(key);
        },
      });
      peer.plain = plain;
      peer.connection = plain.connection;
      await options.onConnection?.(plain.connection);
      return peer;
    }

    const duplex: MessageDuplex = {
      send(frame) {
        const wire = encodeUdpEnvelope('handshake', ++peer.seq, frame);
        udp.send(Buffer.from(wire), port, address);
      },
      onMessage(handler) {
        peer.handlers.add(handler);
        return () => peer.handlers.delete(handler);
      },
      close() {
        peers.delete(key);
      },
    };

    try {
      const session = await SecureSession.connect({ role: 'provider', duplex });
      peer.session = session;
      peer.connection = connectionFromSecureSession(session, 'udp', mode);
      await options.onConnection?.(peer.connection);
    } catch {
      peers.delete(key);
    }
    return peer;
  }

  async function handleDatagram(raw: Uint8Array, rinfo: RemoteInfo): Promise<void> {
    const { port, address } = rinfo;
    let sessionId: string;
    let frame: SocketFrame;
    try {
      const env = decodeUdpEnvelope(raw);
      sessionId = env.sessionId;
      frame = env.frame;
    } catch {
      if (mode === 'plain') {
        sessionId = 'plain';
        frame = binaryFrame(raw);
      } else {
        return;
      }
    }

    const key = peerKey(address, port);
    const existing = peers.get(key);

    if (!existing) {
      await ensurePeer(port, address);
      if (sessionId !== KNOCK_SESSION && frame.data.length > 0) {
        const peer = peers.get(key);
        if (!peer) return;
        if (mode === 'plain') peer.plain?.dispatchMessage(frame);
        else for (const h of peer.handlers) h(frame);
      }
      return;
    }

    if (sessionId === KNOCK_SESSION && frame.data.length === 0) return;

    if (mode === 'plain') {
      existing.plain?.dispatchMessage(frame);
      return;
    }

    for (const h of existing.handlers) h(frame);
  }

  udp.on('message', (msg, rinfo) => {
    void handleDatagram(new Uint8Array(msg), rinfo);
  });

  const address = udp.address();
  const port = typeof address === 'object' ? address.port : (options.port ?? 0);

  return {
    protocol: 'udp',
    securityMode: mode,
    port,
    hostname,
    sendTo(payload, destPort, destAddress, sessionId = 'plain') {
      seq += 1n;
      const wire =
        typeof payload === 'object' && payload !== null && 'kind' in payload
          ? encodeUdpEnvelope(sessionId, seq, payload as SocketFrame)
          : encodeUdpEnvelope(
              sessionId,
              seq,
              typeof payload === 'string'
                ? new TextEncoder().encode(payload)
                : (payload as Uint8Array),
            );
      udp.send(Buffer.from(wire), destPort, destAddress);
    },
    stop() {
      peers.clear();
      udp.close();
    },
  };
}

export async function connectUdpClient(
  options: NodeUdpClientOptions,
): Promise<SocketConnection & { localPort: number }> {
  const mode: SecurityMode = options.security?.mode ?? 'secure';
  const handlers = new Set<(frame: SocketFrame) => void>();
  let seq = 0n;

  const remotePort = options.port;
  const remoteHost = options.hostname;

  const udp = createSocket('udp4');
  await new Promise<void>((resolve, reject) => {
    udp.once('error', reject);
    udp.bind(options.localPort ?? 0, options.localHostname ?? '127.0.0.1', () => {
      udp.off('error', reject);
      resolve();
    });
  });

  udp.on('message', (msg) => {
    try {
      const env = decodeUdpEnvelope(new Uint8Array(msg));
      for (const h of handlers) h(env.frame);
    } catch {
      for (const h of handlers) h(binaryFrame(new Uint8Array(msg)));
    }
  });

  const local = udp.address();
  const localPort = typeof local === 'object' ? local.port : 0;

  if (mode === 'plain') {
    udp.send(
      Buffer.from(encodeUdpEnvelope(KNOCK_SESSION, 0n, binaryFrame(new Uint8Array(0)))),
      remotePort,
      remoteHost,
    );
    await new Promise((r) => setTimeout(r, 10));

    const plain = createPlainConnection({
      protocol: 'udp',
      mode,
      send(frame) {
        const wire = encodeUdpEnvelope('plain', ++seq, frame);
        udp.send(Buffer.from(wire), remotePort, remoteHost);
      },
      close() {
        udp.close();
      },
    });
    handlers.add((frame) => plain.dispatchMessage(frame));
    return Object.assign(plain.connection, { localPort });
  }

  let knocked = false;
  const duplex: MessageDuplex = {
    send(frame) {
      const wire = encodeUdpEnvelope('handshake', ++seq, frame);
      udp.send(Buffer.from(wire), remotePort, remoteHost);
    },
    onMessage(handler) {
      handlers.add(handler);
      if (!knocked) {
        knocked = true;
        queueMicrotask(() => {
          udp.send(
            Buffer.from(encodeUdpEnvelope(KNOCK_SESSION, 0n, binaryFrame(new Uint8Array(0)))),
            remotePort,
            remoteHost,
          );
        });
      }
      return () => handlers.delete(handler);
    },
    close() {
      udp.close();
    },
  };

  const session = await SecureSession.connect({ role: 'consumer', duplex });
  const connection = connectionFromSecureSession(session, 'udp', mode);
  return Object.assign(connection, { localPort });
}

/** @deprecated Use {@link createUdpSocket} */
export const createBunUdpSocket = createUdpSocket;
/** @deprecated Use {@link connectUdpClient} */
export const connectBunUdpClient = connectUdpClient;

export type { UdpSocket };
