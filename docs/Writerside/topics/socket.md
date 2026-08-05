# Sockets

Decorator-driven **WebSocket**, **TCP**, and **UDP** for network peers, with a **WebCrypto secure channel** and first-class **text vs binary** frames.

> **Not the in-process bus.** Core `@Publisher` / `@Subscriber` and [`@di-framework/events`](events.md) move messages inside one process or to brokers. `@di-framework/socket` is for **connections on the wire** (browsers, devices, other hosts).

## Features

- **Decorator API**: `@SocketGateway`, `@OnConnect`, `@OnMessage`, `@OnClose`, `@OnError` — same DI style as `@Controller` and `@EventBridge`.
- **Frame kind**: WebSocket text (opcode 1) vs binary (opcode 2) preserved end-to-end; never silently coerced.
- **Secure channel**: Ephemeral ECDH P-256, HKDF-SHA-256, mutual confirmation, AES-256-GCM (kind authenticated in AAD).
- **Modes**: `secure` (default) or explicit `plain`.
- **Bun adapters**: WebSocket, TCP (length-prefix + kind), UDP (envelope + kind).
- **Cloudflare**: `@di-framework/socket/workers` for Workers and hibernatable Durable Objects.
- **GraphQL**: `@di-framework/socket/graphql` — `graphql-transport-ws` helper for subscriptions.

## Installation

```bash
bun add @di-framework/socket @di-framework/core
```

```bash
npm install @di-framework/socket @di-framework/core
```

Decorators need TypeScript 5 and `experimentalDecorators`. Peer dependency: `@di-framework/core`.

## Not the same as core events

| | Core events | `@di-framework/events` | `@di-framework/socket` |
| --- | --- | --- | --- |
| **What** | In-process bus | Bus ↔ Kafka / NATS | Network I/O |
| **Where bytes go** | Same process | Brokers | Peers on the network |
| **API** | `@Publisher` / `@Subscriber` | `@EventBridge`, transports | `@SocketGateway`, frames, secure session |
| **Security** | N/A | Broker ACLs | Handshake, AEAD, frame kind |

Optional composition: a socket handler may `emit` onto the container bus so existing `@Subscriber`s react — same idea as inbound broker routes.

## Decorator API (primary)

```typescript
import { Component, Container } from '@di-framework/core/decorators';
import { useContainer } from '@di-framework/core/container';
import {
  SocketGateway,
  OnConnect,
  OnMessage,
  OnClose,
  type SocketConnection,
  type SocketFrame,
} from '@di-framework/socket';

@Container()
class LoggerService {
  log(msg: string) {
    console.log(msg);
  }
}

@SocketGateway({
  bun: { protocol: 'websocket', path: '/ws', port: 3000 },
  security: { mode: 'secure' }, // default
})
class ChatGateway {
  @Component(LoggerService)
  logger!: LoggerService;

  @OnConnect()
  open(conn: SocketConnection) {
    this.logger.log(`connected ${conn.id}`);
  }

  @OnMessage({ frame: 'text', type: 'chat' })
  async onChat(conn: SocketConnection, _frame: SocketFrame, msg: { text: string }) {
    await conn.send(JSON.stringify({ type: 'chat', text: `echo:${msg.text}` }));
  }

  @OnMessage({ frame: 'binary' })
  onBin(_conn: SocketConnection, frame: SocketFrame) {
    this.logger.log(`bin ${frame.data.byteLength}`);
  }

  @OnClose()
  close(conn: SocketConnection) {
    this.logger.log(`closed ${conn.id}`);
  }
}

// autoStart (default): listening starts when the class is resolved
useContainer().resolve(ChatGateway);
```

### `@SocketGateway` options

| Option | Meaning |
| --- | --- |
| `bun: { protocol, path?, port?, hostname? }` | Built-in Bun listener (`websocket` \| `tcp` \| `udp`) |
| `listen` | Custom factory for other runtimes |
| `security.mode` | `'secure'` (default) or `'plain'` |
| `autoStart` | Listen on resolve (default `true`) |
| `singleton` | DI lifecycle |
| `maxMessageBytes` | Max payload size (adapter-dependent) |

Manual control: `await gateway.$startGateway()` / `$stopGateway()`, or `startSocketGateways()` / `stopSocketGateways()`.

### Lifecycle handlers

| Decorator | When |
| --- | --- |
| `@OnConnect()` | After accept (and after secure handshake when mode is `secure`) |
| `@OnMessage()` | Every application frame (`SocketFrame`) |
| `@OnMessage({ frame: 'text' \| 'binary' })` | Filter by frame kind |
| `@OnMessage({ type: 'chat' })` | Filter JSON `{ type }` on **text** frames |
| `@OnClose()` | Connection closed |
| `@OnError()` | Handler threw |

## Text vs binary frames

Frame kind is first-class. Do not `TextDecoder` binary payloads or force every message through JSON unless that is the protocol.

| Send | Wire |
| --- | --- |
| `conn.send('hi')` / `textFrame('hi')` | **text** (WebSocket opcode 1) |
| `conn.send(bytes)` / `binaryFrame(bytes)` | **binary** (WebSocket opcode 2) |
| `conn.send(frame)` | as `frame.kind` |

```typescript
import { textFrame, binaryFrame, type SocketFrame } from '@di-framework/socket';

interface SocketFrame {
  kind: 'text' | 'binary';
  data: Uint8Array; // always present
  text?: string;    // only when kind === 'text'
}
```

**Secure channel**

- Handshake: **text** JSON
- Sealed application data: **binary** frames (kind bound in AEAD AAD)
- TCP/UDP: kind byte in length-prefix / UDP envelope header

## Security model

| Property | Mechanism |
| --- | --- |
| Forward secrecy | Ephemeral ECDH P-256 per session |
| Key separation | HKDF-SHA-256 purpose labels |
| MITM detection | Mutual key confirmation MACs |
| Confidentiality + integrity | AES-256-GCM, 96-bit IV |
| Replay (within session) | Monotonic counter in AAD |
| Modes | `secure` default; `plain` opt-in |

**Auth identity ≠ channel keys.** Use [`@di-framework/auth`](auth.md) for *who* (sessions, JWT, WebAuthn). This package owns *wire confidentiality*. Compose both: authenticate at upgrade / `connection_init`, re-check long-lived tokens with auth’s `assertNotExpired`.

**TLS is complementary.** Prefer `wss:` / TLS on the public internet in addition to the app-level channel when using TCP/UDP or multi-hop paths.

Limitations (v0.1): no mid-session rekey; replay protection is per-session; Node/Deno listeners are custom-`listen` only.

## Bun TCP and UDP

```typescript
import {
  createBunTcpServer,
  connectBunTcpClient,
  createBunUdpSocket,
  connectBunUdpClient,
} from '@di-framework/socket/bun';

const tcp = createBunTcpServer({
  security: { mode: 'secure' },
  onConnection(conn) {
    conn.onMessage(async (frame) => {
      await conn.send(frame);
    });
  },
});

const client = await connectBunTcpClient({
  hostname: tcp.hostname,
  port: tcp.port,
});
```

UDP is connectionless: clients send a **knock** datagram so the server can open a per-peer session. Prefer `@SocketGateway({ bun: { protocol: 'tcp' | 'udp' } })` when you want DI handlers.

## GraphQL subscriptions (`graphql-transport-ws`)

```typescript
import { createGraphqlTransportWs } from '@di-framework/socket/graphql';

const graphqlWs = createGraphqlTransportWs({
  execute: (req) => api.execute(req),
  subscribe: (req) => api.subscribe(req),
  contextFromConnectionInit: (payload) => ({
    memberId: (payload as { 'x-member-id'?: string })?.['x-member-id'],
  }),
});

Bun.serve({
  websocket: graphqlWs.websocket,
  fetch(request, server) {
    if (request.headers.get('upgrade') === 'websocket') {
      server.upgrade(request, {
        headers: { 'Sec-WebSocket-Protocol': graphqlWs.subprotocol },
        data: graphqlWs.createData(),
      });
      return undefined;
    }
    // HTTP GraphQL handler…
  },
});
```

Protocol is **text** JSON (GraphiQL / `graphql-ws` clients). Pair with auth via `connectionParamsToHeaders` or `@di-framework/auth`’s `authenticateUpgrade` / `requestFromConnectionParams`.

The GraphQL example uses this helper instead of a hand-rolled WebSocket loop.

## Cloudflare Workers and Durable Objects

Import `@di-framework/socket/workers`.

### Non-hibernating Worker

```typescript
import { createWorkerWebSocketUpgrade } from '@di-framework/socket/workers';

export default {
  fetch(request: Request) {
    return createWorkerWebSocketUpgrade(request, {
      security: { mode: 'secure' }, // or 'plain'
      onConnection(conn) {
        conn.onMessage(async (frame) => {
          await conn.send(frame);
        });
      },
    });
  },
};
```

Uses `WebSocketPair` + `server.accept()` + event listeners. Do **not** use this path if you need Durable Object hibernation billing.

### Hibernatable Durable Object

```typescript
import { HibernatableSocketHub } from '@di-framework/socket/workers';

export class ChatRoom {
  hub: HibernatableSocketHub;

  constructor(ctx: DurableObjectState) {
    this.hub = new HibernatableSocketHub(ctx, {
      security: { mode: 'secure' },
      // After wake:
      //  - 'rehydrate' (default): restore AEAD from serializeAttachment
      //  - 'rehandshake': close 4001 so the client reconnects
      onHibernate: 'rehydrate',
      onConnection(conn) {
        conn.onMessage(async (frame) => {
          await conn.send(frame);
        });
      },
    });
    void this.hub.restoreFromHibernation();
  }

  fetch(request: Request) {
    return this.hub.handleUpgrade(request);
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    return this.hub.webSocketMessage(ws, message);
  }

  webSocketClose(ws: WebSocket) {
    this.hub.webSocketClose(ws);
  }

  webSocketError(ws: WebSocket) {
    this.hub.webSocketError(ws);
  }
}
```

| Policy | Behavior |
| --- | --- |
| `plain` | No ECDH; frames only; fine with hibernation |
| `secure` + `rehydrate` | Snapshot (key + counters) in attachment; restore on wake |
| `secure` + `rehandshake` | On wake, close **4001** — client reconnects and handshakes again |

**Attachment secrets:** rehydrate stores the AES key in `serializeAttachment`. Convenient but sensitive; for higher assurance keep snapshots in DO storage and only store an id in the attachment. Never log snapshots.

**Frame kind on CF:** `string` → text, `ArrayBuffer` → binary (`cfMessageToFrame` / `sendFrame`).

**Do not mix** `ws.accept()` with `ctx.acceptWebSocket(ws)` on the same socket.

Worker front door:

```typescript
export default {
  fetch(request: Request, env: Env) {
    const id = env.CHAT_ROOM.idFromName('lobby');
    return env.CHAT_ROOM.get(id).fetch(request);
  },
};
```

### Helpers

| Export | Use |
| --- | --- |
| `cfMessageToFrame` / `sendFrame` | Map CF messages to `SocketFrame` |
| `duplexFromWebSocket` | Non-hibernating duplex |
| `createPushableDuplex` | DO: `push` from `webSocketMessage` |
| `SecureSession.exportSnapshot` / `rehydrate` | Portable secure session persistence |

## Imperative / low-level API

Useful for tests and custom `listen` factories:

- `@di-framework/socket/bun` — `createBunWebSocketServer`, TCP/UDP clients and servers
- `SecureSession`, `SecureHandshakeProvider` / `SecureHandshakeConsumer`, `AeadChannel`
- Framing: `encodeLengthPrefix`, `LengthPrefixFramer`, UDP envelope helpers

Prefer `@SocketGateway` in application code on Bun. On Cloudflare, prefer the workers helpers (there is no long-lived port listener).

## Capability matrix

| | Bun | Node | Deno | Workers / DO |
| --- | --- | --- | --- | --- |
| Decorators + secure channel | yes | custom `listen` | custom `listen` | via workers hub |
| Built-in listener | `bun:` option | — | — | `@di-framework/socket/workers` |
| Hibernatable WebSockets | — | — | — | `HibernatableSocketHub` |
| TCP / UDP | yes | planned | planned | n/a (no server sockets) |
| `graphql-transport-ws` | yes | yes | yes | yes (WS text) |

## Related

- [Events](events.md) — broker bridge for the in-process bus
- [GraphQL](graphql.md) — schema and `subscribe`; sockets own the subscription transport
- [Authentication](auth.md) — identity; compose with WebSocket `connection_init`
- [HTTP Router](http-router.md) — request/response; upgrade path is socket’s job
