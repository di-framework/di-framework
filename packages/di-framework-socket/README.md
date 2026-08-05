# @di-framework/socket

Decorator-driven **WebSocket**, **TCP**, and **UDP** for [di-framework](https://github.com/di-framework/di-framework) — the same DI style as `@Controller` and `@EventBridge`, with a **WebCrypto secure channel** on the wire.

> Network I/O, not the in-process `@Publisher` / `@Subscriber` bus. Use core events inside the process; use this package for peers on the network.

## Install

```bash
bun add @di-framework/socket @di-framework/core
```

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
} from '@di-framework/socket';

@Container()
class LoggerService {
  log(msg: string) {
    console.log(msg);
  }
}

@SocketGateway({
  // Node primitives (node:http+ws / net / dgram) — works on Node and Bun
  server: { protocol: 'websocket', path: '/ws', port: 3000 },
  security: { mode: 'secure' }, // default — ECDH + AES-GCM session
})
class ChatGateway {
  @Component(LoggerService)
  logger!: LoggerService;

  @OnConnect()
  open(conn: SocketConnection) {
    this.logger.log(`connected ${conn.id}`);
  }

  /** Text frames only, JSON `{ "type": "chat", … }`. */
  @OnMessage({ frame: 'text', type: 'chat' })
  async onChat(
    conn: SocketConnection,
    _frame: import('@di-framework/socket').SocketFrame,
    msg: { type: 'chat'; text: string },
  ) {
    await conn.send(JSON.stringify({ type: 'chat', text: `echo:${msg.text}` }));
  }

  /** Binary WebSocket frames (opcode 2). */
  @OnMessage({ frame: 'binary' })
  onBin(_conn: SocketConnection, frame: import('@di-framework/socket').SocketFrame) {
    this.logger.log(`bin ${frame.data.byteLength}`);
  }

  /** Every application frame (kind preserved). */
  @OnMessage()
  onAny(_conn: SocketConnection, frame: import('@di-framework/socket').SocketFrame) {
    this.logger.log(`${frame.kind} ${frame.data.byteLength}`);
  }

  @OnClose()
  close(conn: SocketConnection) {
    this.logger.log(`closed ${conn.id}`);
  }
}

// autoStart (default): listening starts when the class is resolved
useContainer().resolve(ChatGateway);

// or manually:
// await gateway.$startGateway();
// await stopSocketGateways();
```

### Options

| Option | Meaning |
| --- | --- |
| `server: { protocol, path?, port?, hostname? }` | Built-in listener via **Node primitives** (`websocket` \| `tcp` \| `udp`) |
| `listen` | Custom factory (e.g. Cloudflare Workers) |
| `security.mode` | `'secure'` (default) or `'plain'` |
| `autoStart` | Listen on resolve (default `true`) |
| `singleton` | DI lifecycle (default container behaviour) |

### Text vs binary frames

Frame kind is first-class — never silently coerce:

| Send | Wire |
| --- | --- |
| `conn.send('hi')` / `textFrame('hi')` | **text** (WS opcode 1) |
| `conn.send(bytes)` / `binaryFrame(bytes)` | **binary** (WS opcode 2) |
| `conn.send(frame)` | as `frame.kind` |

Secure channel: handshake = **text** JSON; sealed application data = **binary** frames with kind authenticated in AEAD AAD. TCP/UDP carry kind in the length-prefix / envelope header.

### Lifecycle handlers

| Decorator | When |
| --- | --- |
| `@OnConnect()` | After accept (and after secure handshake when mode is `secure`) |
| `@OnMessage()` / `@OnMessage({ frame, type })` | Application frame (`SocketFrame`) |
| `@OnClose()` | Connection closed |
| `@OnError()` | Handler threw |

Same pattern as:

```ts
@EventBridge({ transport: () => memoryTransport() })
class OrderEvents {
  @Outbound('order.placed', { topic: 'orders' })
  outboundOrders!: void;
}
```

## GraphQL subscriptions

`@di-framework/socket/graphql` is a small `graphql-transport-ws` helper you pass `execute` / `subscribe` into (used by the GraphQL example). It is intentionally transport-shaped so GraphiQL clients work; pair it with auth’s `connection_init` helpers when you need credentials.

```typescript
import { createGraphqlTransportWs } from '@di-framework/socket/graphql';
```

## Security

| Property | Mechanism |
| --- | --- |
| Forward secrecy | Ephemeral ECDH P-256 |
| Key separation | HKDF-SHA-256 purpose labels |
| MITM detection | Mutual confirmation MACs |
| Payload protection | AES-256-GCM, AAD = session + counter |
| Modes | `secure` default; `plain` is opt-in and obvious in review |

Auth identity (who) stays in `@di-framework/auth`. This package owns wire confidentiality.

## TCP / UDP / WebSocket servers (Node primitives)

Adapters use **`node:http` + `ws`**, **`node:net`**, and **`node:dgram`** — not Bun.serve / Bun.listen. The same code runs on Node and on Bun’s Node compatibility layer.

```typescript
import {
  createWebSocketServer,
  connectWebSocketClient,
  createTcpServer,
  connectTcpClient,
  createUdpSocket,
  connectUdpClient,
} from '@di-framework/socket/node';

const ws = createWebSocketServer({
  path: '/ws',
  onConnection(conn) {
    conn.onMessage(async (frame) => {
      await conn.send(frame);
    });
  },
});

const tcp = createTcpServer({ /* length-prefix + kind */ });
const udp = await createUdpSocket({ /* envelope + kind; client knocks */ });
```

## Cloudflare Workers & Durable Objects

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
          await conn.send(frame); // kind preserved
        });
      },
    });
  },
};
```

Uses `WebSocketPair` + `server.accept()` + event listeners. **Do not** use this path if you need hibernation billing.

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
      //  - 'rehandshake': close 4001 so the client opens a new socket
      onHibernate: 'rehydrate',
      onConnection(conn) {
        conn.onMessage(async (frame) => {
          await conn.send(frame);
        });
      },
    });
    // Rebuild live sessions for sockets still held at the edge
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
| `secure` + `rehandshake` | On wake, close **4001** — client must reconnect and handshake again |

**Attachment secrets:** rehydrate stores the AES key in `serializeAttachment`. That is convenient but sensitive; for higher assurance put snapshots in DO storage and only store an id in the attachment. Never log snapshots.

**Frame kind on CF:** `string` → text, `ArrayBuffer` → binary (`cfMessageToFrame` / `sendFrame`).

Worker front door:

```typescript
export default {
  fetch(request: Request, env: Env) {
    const id = env.CHAT_ROOM.idFromName('lobby');
    return env.CHAT_ROOM.get(id).fetch(request);
  },
};
```

## Low-level / adapters

- `@di-framework/socket/node` — `node:http`+`ws`, `node:net`, `node:dgram`  
- `@di-framework/socket/bun` — **deprecated alias** of `/node`  
- `@di-framework/socket/workers` — Workers + hibernatable DO hub (edge-only APIs)  
- `SecureSession` / `exportSnapshot` / `rehydrate` — portable secure channel  

Prefer `@SocketGateway({ server: … })` for process servers; on CF use the workers helpers (no long-lived ports).

## Capability matrix (v0.1)

| | Node | Bun | Deno | Workers / DO |
| --- | --- | --- | --- | --- |
| Decorators + secure channel | yes | yes (Node compat) | custom `listen` | via workers hub |
| Built-in listener | `server:` / `/node` | same Node APIs | — | `./workers` |
| Hibernatable WebSockets | — | — | — | `HibernatableSocketHub` |
| TCP / UDP | `node:net` / `dgram` | same | planned | n/a |

## License

MIT
