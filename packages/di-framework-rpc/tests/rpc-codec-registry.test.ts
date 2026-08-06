import { describe, expect, it } from 'bun:test';
import {
  isJsonRpcCall,
  isJsonRpcResponse,
  JSON_RPC_ERRORS,
  parseJsonRpc,
  serializeJsonRpc,
} from '../src/codec.ts';
import { getRegistry, RpcRegistry, setRegistry } from '../src/registry.ts';

describe('parseJsonRpc - array & object edge cases', () => {
  it('rejects an empty batch array', () => {
    expect(parseJsonRpc([])).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: JSON_RPC_ERRORS.INVALID_REQUEST, message: 'Invalid Request' },
    });
  });

  it('rejects a batch containing an invalid entry', () => {
    expect(parseJsonRpc([{ jsonrpc: '2.0', method: 'x' }, { garbage: true }])).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: JSON_RPC_ERRORS.INVALID_REQUEST, message: 'Invalid Request' },
    });
  });

  it('accepts a valid batch array of calls', () => {
    const batch = [
      { jsonrpc: '2.0', id: 1, method: 'a', params: {} },
      { jsonrpc: '2.0', method: 'b' },
    ];
    expect(parseJsonRpc(batch)).toBe(batch as never);
  });

  it('accepts a valid batch array of responses', () => {
    const batch = [{ jsonrpc: '2.0', id: 1, result: {} }];
    expect(parseJsonRpc(batch)).toBe(batch as never);
    expect(isJsonRpcResponse(batch[0])).toBe(true);
  });

  it('rejects a well-formed but non-call, non-response single object', () => {
    expect(parseJsonRpc({ jsonrpc: '2.0', foo: 'bar' })).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: JSON_RPC_ERRORS.INVALID_REQUEST, message: 'Invalid Request' },
    });
  });

  it('accepts an already-parsed (non-string) call object', () => {
    const call = { jsonrpc: '2.0', id: 'x', method: 'm' };
    expect(parseJsonRpc(call)).toBe(call as never);
  });
});

describe('isJsonRpcCall', () => {
  it('rejects non-object and array inputs', () => {
    expect(isJsonRpcCall(null)).toBe(false);
    expect(isJsonRpcCall('nope')).toBe(false);
    expect(isJsonRpcCall([])).toBe(false);
  });
});

describe('serializeJsonRpc', () => {
  it('serializes a JSON-RPC payload to a JSON string', () => {
    const payload = { jsonrpc: '2.0' as const, id: 1, method: 'm', params: { a: 1 } };
    expect(serializeJsonRpc(payload)).toBe(JSON.stringify(payload));
  });
});

describe('RpcRegistry - getRegistry/setRegistry', () => {
  it('getRegistry() returns the shared default registry singleton', () => {
    expect(getRegistry()).toBeInstanceOf(RpcRegistry);
  });

  it('getMessages() and getServices() reflect registered metadata', () => {
    class Foo {}
    const reg = new RpcRegistry();
    reg.addMessage(Foo, 'Foo');
    expect(reg.getMessages()).toHaveLength(1);
  });

  it('setRegistry() replaces the shared registry contents with another instance', () => {
    class Msg {}
    class Svc {}
    const source = new RpcRegistry();
    source.addMessage(Msg, 'Msg');
    source.addField(Msg, { number: 1, propertyKey: 'id' });
    source.addService(Svc, { package: 'pkg.v1', name: 'Svc' });
    source.addMethod(Svc, {
      propertyKey: 'go',
      name: 'Go',
      input: () => Msg,
      notification: false,
    });

    getRegistry().clear();
    setRegistry(source);

    const target = getRegistry();
    expect(target.getMessage(Msg)?.fields).toHaveLength(1);
    expect(target.getService(Svc)?.methods).toHaveLength(1);
    expect(target.findMethod('pkg.v1.Svc/Go')).toBeDefined();

    target.clear();
  });
});
