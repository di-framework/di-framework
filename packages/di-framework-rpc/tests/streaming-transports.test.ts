import { describe, expect, it } from 'bun:test';
import { createServer } from 'node:http';
import { createRouterTransport } from '@connectrpc/connect';
import {
  createHttpRpcHandler,
  createRpcClient,
  createRpcServer,
  httpTransport,
  memoryPair,
  RpcField,
  RpcMessage,
  RpcMethod,
  RpcService,
  RpcStream,
  Stream,
} from '../index.ts';
import { createGrpcHandler, createGrpcRoutes, grpcTransport } from '../src/adapters/grpc.ts';

@RpcMessage()
class EchoRequest {
  @RpcField(1)
  value!: string;
}

@RpcMessage()
class EchoResponse {
  @RpcField(1)
  result!: string;
}

@RpcService({ package: 'streaming.v1' })
class StreamingService {
  @RpcMethod({ input: () => EchoRequest, output: () => EchoResponse })
  async *serverStream(req: EchoRequest): AsyncIterable<EchoResponse> {
    for (let i = 1; i <= 3; i++) {
      yield { result: `${req.value}-${i}` };
    }
  }

  @RpcMethod({ input: () => Stream(EchoRequest), output: () => EchoResponse })
  async clientStream(items: AsyncIterable<EchoRequest>): Promise<EchoResponse> {
    const acc: string[] = [];
    for await (const item of items) {
      acc.push(item.value);
    }
    return { result: acc.join(',') };
  }

  @RpcStream({ input: () => Stream(EchoRequest), output: () => Stream(EchoResponse) })
  async *bidiStream(items: AsyncIterable<EchoRequest>): AsyncIterable<EchoResponse> {
    for await (const item of items) {
      yield { result: `echo:${item.value}` };
    }
  }
}

describe('streaming across transports', () => {
  it('memoryPair transport: server, client, and bi-directional streaming', async () => {
    const pair = memoryPair();
    const server = createRpcServer({ transport: pair.serverTransport });
    await server.start();
    const client = createRpcClient(StreamingService, pair.clientTransport);

    // 1. Server streaming
    const serverItems: string[] = [];
    for await (const item of client.serverStream({ value: 'hello' })) {
      serverItems.push(item.result);
    }
    expect(serverItems).toEqual(['hello-1', 'hello-2', 'hello-3']);

    // 2. Client streaming
    const clientResult = await client.clientStream(
      (async function* () {
        yield { value: 'a' };
        yield { value: 'b' };
        yield { value: 'c' };
      })(),
    );
    expect(clientResult).toEqual({ result: 'a,b,c' });

    // 3. Bi-directional streaming
    const bidiItems: string[] = [];
    const bidiIterable = client.bidiStream(
      (async function* () {
        yield { value: 'ping1' };
        yield { value: 'ping2' };
      })(),
    );
    for await (const item of bidiIterable) {
      bidiItems.push(item.result);
    }
    expect(bidiItems).toEqual(['echo:ping1', 'echo:ping2']);

    await server.stop();
  });

  it('HTTP transport (SSE/chunked): server-streaming', async () => {
    const handler = createHttpRpcHandler();
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const body = await new Promise<Buffer>((resolve) => {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => resolve(Buffer.concat(chunks)));
      });
      const webReq = new Request(url.toString(), {
        method: req.method,
        headers: req.headers as Record<string, string>,
        body: req.method === 'POST' ? body : undefined,
      });

      const webRes = await handler(webReq);
      res.statusCode = webRes.status;
      webRes.headers.forEach((val, key) => {
        res.setHeader(key, val);
      });

      if (webRes.body) {
        const reader = webRes.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
      }
      res.end();
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    const url = `http://127.0.0.1:${address.port}/rpc`;

    const transport = httpTransport({ url });
    const client = createRpcClient(StreamingService, transport);

    const items: string[] = [];
    for await (const item of client.serverStream({ value: 'http-test' })) {
      items.push(item.result);
    }
    expect(items).toEqual(['http-test-1', 'http-test-2', 'http-test-3']);

    server.close();
  });

  it('gRPC / Connect transport: server-streaming over HTTP and full streaming over routerTransport', async () => {
    const handler = createGrpcHandler();
    const server = createServer((req, res) => {
      void handler(req, res);
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    const url = `http://127.0.0.1:${address.port}`;

    // 1. Live HTTP gRPC Server-Streaming
    const httpGrpcTransport = grpcTransport({ baseUrl: url });
    const httpClient = createRpcClient(StreamingService, httpGrpcTransport);
    const serverItems: string[] = [];
    for await (const item of httpClient.serverStream({ value: 'grpc' })) {
      serverItems.push(item.result);
    }
    expect(serverItems).toEqual(['grpc-1', 'grpc-2', 'grpc-3']);
    server.close();

    // 2. Full streaming (Server, Client, BiDi) over Connect Router Transport
    const routerTransport = createRouterTransport(createGrpcRoutes());
    const transport = grpcTransport({ transport: routerTransport });
    const client = createRpcClient(StreamingService, transport);

    // Client streaming
    const clientRes = await client.clientStream(
      (async function* () {
        yield { value: 'x' };
        yield { value: 'y' };
      })(),
    );
    expect(clientRes).toEqual({ result: 'x,y' });

    // Bi-directional streaming
    const bidiRes: string[] = [];
    for await (const item of client.bidiStream(
      (async function* () {
        yield { value: 'req1' };
        yield { value: 'req2' };
      })(),
    )) {
      bidiRes.push(item.result);
    }
    expect(bidiRes).toEqual(['echo:req1', 'echo:req2']);
  });
});
