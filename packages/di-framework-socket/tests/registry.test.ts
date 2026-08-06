import { describe, expect, it } from 'bun:test';
import { getRegistry, SocketGatewayRegistry, setRegistry } from '../src/registry.ts';

class FakeGateway {}
class OtherGateway {}

describe('SocketGatewayRegistry', () => {
  it('dedupes addTarget and accumulates handlers', () => {
    const reg = new SocketGatewayRegistry();
    reg.addTarget(FakeGateway);
    reg.addTarget(FakeGateway); // no-op: already present
    reg.addHandler(FakeGateway, { kind: 'connect', method: 'open' });
    reg.addHandler(FakeGateway, { kind: 'message', method: 'onMsg' });

    expect(reg.all()).toHaveLength(1);
    expect(reg.get(FakeGateway)?.handlers).toHaveLength(2);
    expect(reg.get(OtherGateway)).toBeUndefined();

    reg.clear();
    expect(reg.all()).toHaveLength(0);
  });

  it('getRegistry() returns the shared singleton', () => {
    const shared = getRegistry();
    shared.addTarget(FakeGateway);
    expect(getRegistry()).toBe(shared);
    expect(getRegistry().get(FakeGateway)).toBeDefined();
    shared.clear();
  });

  it('setRegistry() replaces the shared singleton contents', () => {
    const replacement = new SocketGatewayRegistry();
    replacement.addHandler(FakeGateway, { kind: 'close', method: 'onClose' });
    replacement.addHandler(OtherGateway, { kind: 'error', method: 'onErr' });

    setRegistry(replacement);

    const shared = getRegistry();
    expect(shared.get(FakeGateway)?.handlers).toEqual([{ kind: 'close', method: 'onClose' }]);
    expect(shared.get(OtherGateway)?.handlers).toEqual([{ kind: 'error', method: 'onErr' }]);

    shared.clear();
  });
});
