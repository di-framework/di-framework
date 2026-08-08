import { describe, expect, it } from 'bun:test';
import {
  createRpcClient,
  RpcField,
  RpcMessage,
  RpcMethod,
  RpcService,
  RpcStream,
  registry,
  Stream,
} from '../index.ts';
import { compileConnectSchema } from '../src/schema/connect.ts';

@RpcMessage()
class LogFilter {
  @RpcField(1)
  level!: string;
}

@RpcMessage()
class LogEntry {
  @RpcField(1)
  message!: string;
}

@RpcMessage()
class MetricPoint {
  @RpcField({ number: 1, type: 'double' })
  value!: number;
}

@RpcMessage()
class MetricSummary {
  @RpcField({ number: 1, type: 'int32' })
  count!: number;
}

describe('streaming schema and metadata detection', () => {
  it('zero-config server-streaming detection via async * generator', () => {
    @RpcService({ package: 'telemetry.v1' })
    class ZeroConfigService {
      @RpcMethod({ input: () => LogFilter, output: () => LogEntry })
      async *streamLogs(filter: LogFilter): AsyncIterable<LogEntry> {
        yield { message: `level:${filter.level}` };
      }
    }

    const serviceMeta = registry.getService(ZeroConfigService);
    expect(serviceMeta).toBeDefined();
    expect(serviceMeta?.package).toBe('telemetry.v1');

    const compiled = compileConnectSchema();
    const compiledService = serviceMeta ? compiled.services.get(serviceMeta) : undefined;
    expect(compiledService).toBeDefined();

    const methodDesc = compiledService?.methods.find((m) => m.name === 'StreamLogs');
    expect(methodDesc).toBeDefined();
    expect(methodDesc?.methodKind).toBe('server_streaming');
  });

  it('Stream(Message) type wrapper metadata registration for client and bi-di streaming', () => {
    @RpcService({ package: 'telemetry.v1' })
    class StreamWrapperService {
      @RpcMethod({ input: () => Stream(MetricPoint), output: () => MetricSummary })
      async uploadMetrics(points: AsyncIterable<MetricPoint>): Promise<MetricSummary> {
        let count = 0;
        for await (const _ of points) count++;
        return { count };
      }

      @RpcStream({ input: () => Stream(MetricPoint), output: () => Stream(LogEntry) })
      async *bidiMetrics(points: AsyncIterable<MetricPoint>): AsyncIterable<LogEntry> {
        for await (const p of points) {
          yield { message: `metric:${p.value}` };
        }
      }
    }

    const serviceMeta = registry.getService(StreamWrapperService);
    expect(serviceMeta).toBeDefined();

    const uploadMeta = serviceMeta?.methods.find((m) => m.name === 'UploadMetrics');
    expect(uploadMeta?.clientStreaming).toBe(true);

    const bidiMeta = serviceMeta?.methods.find((m) => m.name === 'BidiMetrics');
    expect(bidiMeta?.clientStreaming).toBe(true);
    expect(bidiMeta?.serverStreaming).toBe(true);

    const compiled = compileConnectSchema();
    const compiledService = serviceMeta ? compiled.services.get(serviceMeta) : undefined;
    expect(compiledService).toBeDefined();

    const uploadDesc = compiledService?.methods.find((m) => m.name === 'UploadMetrics');
    expect(uploadDesc?.methodKind).toBe('client_streaming');

    const bidiDesc = compiledService?.methods.find((m) => m.name === 'BidiMetrics');
    expect(bidiDesc?.methodKind).toBe('bidi_streaming');
  });

  it('messagesForPackage includes nested and streamed message types', () => {
    const messages = registry.messagesForPackage('telemetry.v1');
    const names = messages.map((m) => m.name);
    expect(names).toContain('LogFilter');
    expect(names).toContain('LogEntry');
    expect(names).toContain('MetricPoint');
    expect(names).toContain('MetricSummary');
  });

  it('typed RpcClient inference compiles and preserves AsyncIterable types', () => {
    @RpcService({ package: 'test.v1' })
    class TypeTestService {
      @RpcMethod({ input: () => LogFilter, output: () => LogEntry })
      async *streamLogs(filter: LogFilter): AsyncIterable<LogEntry> {
        yield { message: filter.level };
      }

      @RpcMethod({ input: () => Stream(MetricPoint), output: () => MetricSummary })
      async uploadMetrics(_points: AsyncIterable<MetricPoint>): Promise<MetricSummary> {
        return { count: 1 };
      }
    }

    const dummyTransport = {
      send: async () => {},
      subscribe: () => () => {},
    };

    const client = createRpcClient(TypeTestService, dummyTransport);

    // Type assertions
    const streamRes = client.streamLogs({ level: 'info' });
    expect(typeof streamRes[Symbol.asyncIterator]).toBe('function');

    const uploadRes = client.uploadMetrics(
      (async function* () {
        yield { value: 1.0 };
      })(),
    );
    expect(typeof uploadRes.then).toBe('function');
  });
});
