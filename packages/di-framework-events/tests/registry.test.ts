import { beforeEach, describe, expect, it } from 'bun:test';
import registry, { EventBridgeRegistry, getRegistry, setRegistry } from '../src/registry.ts';

class FakeTarget {}
class OtherTarget {}

beforeEach(() => {
  registry.clear();
});

describe('EventBridgeRegistry', () => {
  it('exposes getTargets() for all registered targets', () => {
    registry.addTarget(FakeTarget);
    registry.addTarget(OtherTarget);
    expect(registry.getTargets()).toEqual(expect.arrayContaining([FakeTarget, OtherTarget]));
  });

  it('getRegistry() returns the shared singleton', () => {
    expect(getRegistry()).toBe(registry);
  });

  it('setRegistry() replaces the singleton contents while preserving identity', () => {
    const replacement = new EventBridgeRegistry();
    replacement.addOutbound(FakeTarget, { event: 'e1', topic: 't1' });
    replacement.addInbound(OtherTarget, { topic: 't2', event: 'e2' });

    setRegistry(replacement);

    expect(getRegistry()).toBe(registry); // singleton identity unchanged
    const entries = registry.getAll();
    expect(entries).toHaveLength(2);
    expect(registry.get(FakeTarget)?.outbound).toEqual([
      expect.objectContaining({ event: 'e1', topic: 't1' }),
    ]);
    expect(registry.get(OtherTarget)?.inbound).toEqual([
      expect.objectContaining({ topic: 't2', event: 'e2' }),
    ]);
  });
});
