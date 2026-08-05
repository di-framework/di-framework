import { beforeEach, describe, expect, it } from 'bun:test';
import { useContainer } from '@di-framework/core/container';
import { compileConnectSchema } from '../src/schema/connect.ts';
import {
  decodeRpcMessage,
  encodeRpcMessage,
  hydrateRpcMessage,
  printProto,
  rpcMessageToJson,
} from '../src/schema/messages.ts';
import { RpcField, RpcMessage, RpcMethod, RpcService } from '../src/decorators.ts';
import registry, { RpcRegistry } from '../src/registry.ts';
import { createRpcDispatcher } from '../src/dispatcher.ts';
import { memoryPair } from '../src/adapters/memory.ts';
import { createRpcClient } from '../src/client.ts';
import { createRpcServer } from '../src/server.ts';

beforeEach(() => {
  useContainer().clear();
  registry.clear();
});

describe('compileConnectSchema - scalar descriptor types', () => {
  it('compiles every scalar type branch (bool, int32, int64, double, bytes, default string)', () => {
    @RpcMessage()
    class AllScalars {
      @RpcField({ number: 1, type: 'bool' })
      flag!: boolean;

      @RpcField({ number: 2, type: 'int32' })
      count!: number;

      @RpcField({ number: 3, type: 'int64' })
      big!: bigint;

      @RpcField({ number: 4, type: 'double' })
      score!: number;

      @RpcField({ number: 5, type: 'bytes' })
      blob!: Uint8Array;

      @RpcField(6)
      label!: string;
    }

    @RpcService({ package: 'scalars.v1' })
    class ScalarService {
      @RpcMethod({ input: () => AllScalars, output: () => AllScalars })
      echo(value: AllScalars): AllScalars {
        return value;
      }
    }
    void ScalarService;

    const schema = compileConnectSchema();
    expect(schema.messages.get('scalars.v1.AllScalars')).toBeDefined();
    expect(schema.services.size).toBe(1);
  });

  it('throws when a nested message field type is not @RpcMessage-decorated', () => {
    class NotDecorated {}

    @RpcMessage()
    class Wrapper {
      @RpcField({ number: 1, type: () => NotDecorated })
      nested!: unknown;
    }

    @RpcService({ package: 'broken.v1' })
    class BrokenService {
      @RpcMethod({ input: () => Wrapper, output: () => Wrapper })
      go(value: Wrapper): Wrapper {
        return value;
      }
    }
    void BrokenService;

    expect(() => compileConnectSchema()).toThrow(/is not decorated with @RpcMessage/);
  });

  it('throws when a method input type is not @RpcMessage-decorated', () => {
    class UndecoratedInput {}

    @RpcMessage()
    class Output {
      @RpcField(1)
      x!: string;
    }

    @RpcService({ package: 'badinput.v1' })
    class BadInputService {
      @RpcMethod({
        input: () => UndecoratedInput as unknown as new () => object,
        output: () => Output,
      })
      go(value: unknown): Output {
        return value as Output;
      }
    }
    void BadInputService;

    expect(() => compileConnectSchema()).toThrow(/input is not decorated with @RpcMessage/);
  });

  it('throws when a method output type is not @RpcMessage-decorated', () => {
    class UndecoratedOutput {}

    @RpcMessage()
    class Input {
      @RpcField(1)
      x!: string;
    }

    @RpcService({ package: 'badoutput.v1' })
    class BadOutputService {
      @RpcMethod({
        input: () => Input,
        output: () => UndecoratedOutput as unknown as new () => object,
      })
      go(value: Input): unknown {
        return value;
      }
    }
    void BadOutputService;

    expect(() => compileConnectSchema()).toThrow(/output is not decorated with @RpcMessage/);
  });
});

describe('schema/messages - metadataFor guard', () => {
  it('throws for encode/decode/hydrate/toJson/printProto on an undecorated target', () => {
    class Plain {}
    expect(() => encodeRpcMessage(Plain, {})).toThrow(/is not decorated with @RpcMessage/);
    expect(() => decodeRpcMessage(Plain, new Uint8Array())).toThrow(
      /is not decorated with @RpcMessage/,
    );
    expect(() => hydrateRpcMessage(Plain, {})).toThrow(/is not decorated with @RpcMessage/);
    expect(() => rpcMessageToJson(Plain, {})).toThrow(/is not decorated with @RpcMessage/);
  });
});

describe('schema/messages - binary wire-format edge cases', () => {
  it('encodes bytes fields from ArrayBuffer and non-buffer fallbacks', () => {
    @RpcMessage()
    class BlobMsg {
      @RpcField({ number: 1, type: 'bytes' })
      data!: unknown;
    }

    const fromArrayBuffer = encodeRpcMessage(BlobMsg, {
      data: new Uint8Array([9, 8, 7]).buffer,
    });
    const decoded1 = decodeRpcMessage(BlobMsg, fromArrayBuffer) as { data: Uint8Array };
    expect([...decoded1.data]).toEqual([9, 8, 7]);

    // Neither Uint8Array nor ArrayBuffer: falls back to an empty buffer.
    const fromOther = encodeRpcMessage(BlobMsg, { data: 'not-a-buffer' as unknown });
    const decoded2 = decodeRpcMessage(BlobMsg, fromOther) as { data: Uint8Array };
    expect(decoded2.data.length).toBe(0);
  });

  it('throws when a repeated field value is not an array', () => {
    @RpcMessage()
    class RepMsg {
      @RpcField({ number: 1, type: 'string', repeated: true })
      items!: string[];
    }
    expect(() => encodeRpcMessage(RepMsg, { items: 'nope' as unknown })).toThrow(
      /must be an array/,
    );
  });

  it('round-trips a large int64 value beyond MAX_SAFE_INTEGER as bigint', () => {
    @RpcMessage()
    class BigMsg {
      @RpcField({ number: 1, type: 'int64' })
      value!: bigint | number;
    }
    const huge = BigInt(Number.MAX_SAFE_INTEGER) + 10n;
    const encoded = encodeRpcMessage(BigMsg, { value: huge });
    const decoded = decodeRpcMessage(BigMsg, encoded) as { value: bigint | number };
    expect(decoded.value).toBe(huge);

    const smallEncoded = encodeRpcMessage(BigMsg, { value: 42 });
    const smallDecoded = decodeRpcMessage(BigMsg, smallEncoded) as { value: bigint | number };
    expect(smallDecoded.value).toBe(42);
  });

  it('skips unknown field numbers (wire types 0, 1, 2) during decode', () => {
    @RpcMessage()
    class KnownOnly {
      @RpcField({ number: 1, type: 'string' })
      name!: string;
    }
    // Build bytes for KnownOnly (field 1) but decode against a registry where
    // extra unknown fields (2: varint, 3: fixed64/double, 4: length-delimited)
    // appear first, forcing skipField() to run for wire types 0, 1, and 2.
    const known = encodeRpcMessage(KnownOnly, { name: 'x' });

    function varint(n: number): number[] {
      const out: number[] = [];
      let v = n;
      do {
        let b = v & 0x7f;
        v >>>= 7;
        if (v > 0) b |= 0x80;
        out.push(b);
      } while (v > 0);
      return out;
    }
    const tag = (num: number, wire: number) => varint((num << 3) | wire);
    const unknownVarint = [...tag(2, 0), ...varint(5)];
    const unknownFixed64 = [...tag(3, 1), 0, 0, 0, 0, 0, 0, 0, 0];
    const unknownLenDelim = [...tag(4, 2), ...varint(2), 65, 66];

    const combined = new Uint8Array([
      ...unknownVarint,
      ...unknownFixed64,
      ...unknownLenDelim,
      ...known,
    ]);
    const decoded = decodeRpcMessage(KnownOnly, combined) as { name: string };
    expect(decoded.name).toBe('x');
  });

  it('throws on an unsupported wire type during decode', () => {
    @RpcMessage()
    class Simple {
      @RpcField(1)
      name!: string;
    }
    // Field number 1, wire type 6 (unsupported): tag = (1 << 3) | 6 = 14.
    const bytes = new Uint8Array([14]);
    expect(() => decodeRpcMessage(Simple, bytes)).toThrow(/Unsupported protobuf wire type/);
  });

  it('skips an unknown fixed32 (wire type 5) field during decode', () => {
    @RpcMessage()
    class KnownOnly2 {
      @RpcField({ number: 1, type: 'string' })
      name!: string;
    }
    const known = encodeRpcMessage(KnownOnly2, { name: 'y' });
    // Unknown field number 9, wire type 5 (fixed32): tag = (9 << 3) | 5 = 77.
    const unknownFixed32 = [77, 0, 0, 0, 0];
    const combined = new Uint8Array([...unknownFixed32, ...known]);
    const decoded = decodeRpcMessage(KnownOnly2, combined) as { name: string };
    expect(decoded.name).toBe('y');
  });

  it('throws "Invalid protobuf varint" for a runaway continuation-bit sequence', () => {
    @RpcMessage()
    class Simple2 {
      @RpcField(1)
      name!: string;
    }
    // 11 bytes, each with the continuation bit set: the varint reader's
    // shift exceeds 70 without ever seeing a terminating (high-bit-clear) byte.
    const bytes = new Uint8Array(11).fill(0xff);
    expect(() => decodeRpcMessage(Simple2, bytes)).toThrow(/Invalid protobuf varint/);
  });

  it('rejects non-object input to hydrateRpcMessage', () => {
    @RpcMessage()
    class HInput {
      @RpcField(1)
      x!: string;
    }
    expect(() => hydrateRpcMessage(HInput, null)).toThrow(/input must be an object/);
    expect(() => hydrateRpcMessage(HInput, [1, 2])).toThrow(/input must be an object/);
    expect(() => hydrateRpcMessage(HInput, 'nope')).toThrow(/input must be an object/);
  });
});

describe('schema/messages - nested + bytes fields through a live RPC round trip', () => {
  it('hydrates nested (non-repeated) and repeated message fields, and base64 bytes, end to end', async () => {
    @RpcMessage()
    class Address {
      @RpcField(1)
      city!: string;
    }

    @RpcMessage()
    class Profile {
      @RpcField(1)
      name!: string;

      @RpcField({ number: 2, type: () => Address })
      home!: Address;

      @RpcField({ number: 3, type: () => Address, repeated: true })
      other!: Address[];

      @RpcField({ number: 4, type: 'bytes' })
      avatar!: Uint8Array;
    }

    @RpcService({ package: 'nested.v1' })
    class ProfileService {
      @RpcMethod({ input: () => Profile, output: () => Profile })
      save(profile: Profile): Profile {
        return profile;
      }
    }
    void ProfileService;

    const pair = memoryPair();
    const server = createRpcServer({ transport: pair.serverTransport });
    await server.start();
    const client = createRpcClient(ProfileService, pair.clientTransport);

    const avatarBytes = new Uint8Array([1, 2, 3]);
    // Send bytes as a base64 string, matching what a real JSON transport
    // would deliver on the wire, to exercise hydrateRpcMessage's base64 branch.
    const avatarBase64 = btoa(String.fromCharCode(...avatarBytes));
    const result = await client.save({
      name: 'Ada',
      home: { city: 'London' },
      other: [{ city: 'Paris' }, { city: 'Berlin' }],
      avatar: avatarBase64 as unknown as Uint8Array,
    });

    expect(result).toEqual({
      name: 'Ada',
      home: { city: 'London' },
      other: [{ city: 'Paris' }, { city: 'Berlin' }],
      avatar: avatarBase64,
    });

    await server.stop();
  });
});

describe('printProto - empty registry', () => {
  it('returns a bare syntax header when no services are registered', () => {
    expect(printProto(new RpcRegistry())).toBe('syntax = "proto3";\n');
  });
});

describe('printProto - undecorated dependency guard', () => {
  it('surfaces the metadataFor error when printing a field whose message type is undecorated', () => {
    class NotAMessage {}
    @RpcMessage()
    class HasBadField {
      @RpcField({ number: 1, type: () => NotAMessage })
      thing!: unknown;
    }
    @RpcService({ package: 'printbad.v1' })
    class PrintBadService {
      @RpcMethod({ input: () => HasBadField, output: () => HasBadField })
      go(value: HasBadField): HasBadField {
        return value;
      }
    }
    void PrintBadService;

    expect(() => printProto()).toThrow(/is not decorated with @RpcMessage/);
  });
});

describe('createRpcDispatcher - not-callable guard', () => {
  it('returns a SERVER error when the resolved handler is not a function', async () => {
    @RpcMessage()
    class Req {
      @RpcField(1)
      id!: string;
    }
    @RpcService({ package: 'notcallable.v1' })
    class NotCallableService {
      @RpcMethod({ input: () => Req, output: () => Req })
      go(request: Req): Req {
        return request;
      }
    }

    const instance = useContainer().resolve(NotCallableService) as unknown as Record<
      string,
      unknown
    >;
    instance.go = undefined;

    const dispatcher = createRpcDispatcher();
    const response = await dispatcher.dispatch({
      jsonrpc: '2.0',
      id: 1,
      method: 'notcallable.v1.NotCallableService/Go',
      params: { id: '1' },
    });

    expect(response).toEqual({
      jsonrpc: '2.0',
      id: 1,
      error: expect.objectContaining({ message: expect.stringContaining('is not callable') }),
    });
  });
});

describe('RpcRegistry re-export sanity', () => {
  it('exposes RpcRegistry as a constructible class', () => {
    expect(new RpcRegistry()).toBeInstanceOf(RpcRegistry);
  });
});
