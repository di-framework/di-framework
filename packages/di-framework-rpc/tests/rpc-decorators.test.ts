import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { useContainer } from '@di-framework/core/container';
import { memoryPair } from '../src/adapters/memory.ts';
import {
  RpcField,
  RpcMessage,
  RpcMethod,
  RpcService,
  RpcStream,
  Stream,
  startRpcServices,
  stopRpcServices,
  unwrapStream,
} from '../src/decorators.ts';
import registry from '../src/registry.ts';
import type { RpcServiceHost } from '../src/types.ts';

beforeEach(() => {
  useContainer().clear();
  registry.clear();
});

describe('@RpcField - non-string property keys', () => {
  it('throws when applied to a symbol-keyed property', () => {
    expect(() => {
      class Bad {}
      RpcField(1)(Bad.prototype, Symbol('sym'));
    }).toThrow(/requires a string property name/);
  });
});

describe('@RpcField - invalid field numbers', () => {
  it('throws for a non-integer or out-of-range field number', () => {
    expect(() => {
      class Bad {
        @RpcField(0)
        x!: string;
      }
      void Bad;
    }).toThrow(/invalid protobuf field number/);

    expect(() => {
      class Bad2 {
        @RpcField(1.5)
        x!: string;
      }
      void Bad2;
    }).toThrow(/invalid protobuf field number/);

    expect(() => {
      class Bad3 {
        @RpcField(536_870_912)
        x!: string;
      }
      void Bad3;
    }).toThrow(/invalid protobuf field number/);
  });
});

describe('@RpcService - no transport configured', () => {
  it('throws from $startRpc when no transport is available', async () => {
    @RpcMessage()
    class Req {
      @RpcField(1)
      id!: string;
    }
    @RpcService({ package: 'notransport.v1', autoStart: false })
    class NoTransportService {
      @RpcMethod({ input: () => Req, output: () => Req })
      go(req: Req): Req {
        return req;
      }
    }

    const instance = useContainer().resolve(NoTransportService) as unknown as RpcServiceHost;
    await expect(instance.$startRpc()).rejects.toThrow(/has no transport/);
  });

  it('logs via console.error when the queued autoStart $startRpc rejects', async () => {
    @RpcMessage()
    class Req {
      @RpcField(1)
      id!: string;
    }

    const errorSpy = mock(() => {});
    const original = console.error;
    console.error = errorSpy;
    try {
      @RpcService({ package: 'autofail.v1', transport: undefined as never })
      class AutoFailService {
        @RpcMethod({ input: () => Req, output: () => Req })
        go(req: Req): Req {
          return req;
        }
      }
      void AutoFailService;
      // transport is falsy, so options.transport && autoStart !== false is
      // false -- this decorator variant never wraps with AutoRpcService.
      // Use a transport factory that throws asynchronously instead below.
    } finally {
      console.error = original;
    }

    @RpcService({
      package: 'autofail2.v1',
      transport: () => {
        throw new Error('factory boom');
      },
    })
    class AutoFailService2 {
      @RpcMethod({ input: () => Req, output: () => Req })
      go(req: Req): Req {
        return req;
      }
    }

    console.error = errorSpy;
    try {
      useContainer().resolve(AutoFailService2);
      await Bun.sleep(20);
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      console.error = original;
    }
  });
});

describe('startRpcServices / stopRpcServices', () => {
  it('registers a service with a custom container when it is not yet present, then resolves it', async () => {
    @RpcMessage()
    class PingRequest {
      @RpcField(1)
      value!: string;
    }
    @RpcMessage()
    class PingResponse {
      @RpcField(1)
      value!: string;
    }
    @RpcService({ package: 'startsvc.v1', autoStart: false })
    class PingService {
      @RpcMethod({ input: () => PingRequest, output: () => PingResponse })
      ping(request: PingRequest): PingResponse {
        return { value: request.value };
      }
    }

    const registered = new Set<unknown>();
    const resolved: unknown[] = [];
    const customContainer = {
      has: (target: unknown) => registered.has(target),
      register: (target: unknown) => {
        registered.add(target);
      },
      resolve: (target: unknown) => {
        resolved.push(target);
        return target === PingService ? new PingService() : undefined;
      },
    };

    const pair = memoryPair();
    const handles = await startRpcServices({
      transport: pair.serverTransport,
      container: customContainer,
    });
    expect(handles).toHaveLength(1);
    expect(registered.has(PingService)).toBe(true);
    expect(resolved).toContain(PingService);

    await stopRpcServices();
  });

  it('skips re-registering a service the custom container already has', async () => {
    @RpcMessage()
    class Req {
      @RpcField(1)
      id!: string;
    }
    @RpcService({ package: 'startsvc2.v1', autoStart: false })
    class AlreadyRegistered {
      @RpcMethod({ input: () => Req, output: () => Req })
      go(req: Req): Req {
        return req;
      }
    }

    const registerSpy = mock(() => {});
    const customContainer = {
      has: () => true,
      register: registerSpy,
      resolve: (target: unknown) =>
        target === AlreadyRegistered ? new AlreadyRegistered() : undefined,
    };

    const pair = memoryPair();
    const handles = await startRpcServices({
      transport: pair.serverTransport,
      container: customContainer,
    });
    expect(handles).toHaveLength(1);
    expect(registerSpy).not.toHaveBeenCalled();
    await stopRpcServices();
  });

  it('stopRpcServices() is a no-op when nothing is active', async () => {
    await expect(stopRpcServices()).resolves.toBeUndefined();
  });
});

describe('@RpcService - $startRpc idempotency and $stopRpc', () => {
  it('returns the existing handle when $startRpc is called while already started, and $stopRpc tears it down', async () => {
    @RpcMessage()
    class Req {
      @RpcField(1)
      id!: string;
    }
    const pair = memoryPair();

    @RpcService({ package: 'idempotent.v1', transport: pair.serverTransport, autoStart: false })
    class IdempotentService {
      @RpcMethod({ input: () => Req, output: () => Req })
      go(req: Req): Req {
        return req;
      }
    }

    const instance = useContainer().resolve(IdempotentService) as unknown as RpcServiceHost;
    const handle1 = await instance.$startRpc();
    const handle2 = await instance.$startRpc();
    expect(handle2).toBe(handle1);
    expect(handle1.started).toBe(true);

    await instance.$stopRpc();
    expect(handle1.started).toBe(false);
    // Calling stop again with no active handle is a no-op.
    await instance.$stopRpc();
  });
});

describe('unwrapStream / RpcStream decorator branches', () => {
  it('unwraps Stream wrappers, constructors, factories, non-functions, and prototype-throwing proxies', () => {
    @RpcMessage()
    class Msg {
      @RpcField(1)
      id!: string;
    }

    expect(unwrapStream(Stream(Msg))).toBe(Msg);
    expect(unwrapStream(Msg)).toBe(Msg);
    expect(unwrapStream(() => Msg)).toBe(Msg);
    expect(unwrapStream(Stream(() => Msg))).toBe(Msg);
    expect(unwrapStream(Msg as unknown)).toBe(Msg);
    // Non-function, non-stream value takes the final return path.
    expect(unwrapStream('plain' as never) as unknown).toBe('plain');

    const throwingProto = new Proxy(function ThrowingProto() {}, {
      get(target, prop, receiver) {
        if (prop === 'prototype') throw new Error('prototype blocked');
        return Reflect.get(target, prop, receiver);
      },
      apply() {
        return Msg;
      },
    }) as unknown as () => typeof Msg;

    expect(unwrapStream(throwingProto)).toBe(Msg);
  });

  it('accepts a non-function output value and updates streaming flags via @RpcStream', () => {
    @RpcMessage()
    class Req {
      @RpcField(1)
      id!: string;
    }
    @RpcMessage()
    class Res {
      @RpcField(1)
      id!: string;
    }

    @RpcService({ package: 'decgaps.v1', autoStart: false })
    class DecGapsService {
      // Stream(...) is an object (not a function), covering the non-function output branch.
      @RpcMethod({ input: () => Req, output: Stream(Res) as never })
      streamedOut(req: Req): Res {
        return req;
      }

      // Bottom decorator runs first: register via @RpcMethod, then @RpcStream updates flags.
      @RpcStream({ clientStreaming: true, serverStreaming: true } as never)
      @RpcMethod({ input: () => Req, output: () => Res })
      go(req: Req): Res {
        return req;
      }

      @RpcStream()
      @RpcMethod({ input: () => Req, output: () => Res })
      bare(req: Req): Res {
        return req;
      }

      @RpcStream({ input: () => Req, output: () => Res })
      direct(req: Req): Res {
        return req;
      }
    }

    const service = registry.getService(DecGapsService);
    const streamedOut = service?.methods.find((m) => m.propertyKey === 'streamedOut');
    expect(streamedOut?.serverStreaming).toBe(true);

    const go = service?.methods.find((m) => m.propertyKey === 'go');
    expect(go?.clientStreaming).toBe(true);
    expect(go?.serverStreaming).toBe(true);
    expect(go?.output).toBeDefined();

    const bare = service?.methods.find((m) => m.propertyKey === 'bare');
    expect(bare).toBeDefined();

    const direct = service?.methods.find((m) => m.propertyKey === 'direct');
    expect(direct).toBeDefined();
  });
});
