import { beforeEach, describe, expect, it } from 'bun:test';
import { Container, container as globalContainer, useContainer } from '../container';
import { Component } from '../decorators';

class Foo {
  value = Math.random();
}
class Bar {
  constructor(public foo: Foo) {}
}

// Helper factory
const makeValueFactory = () => ({ n: Math.random() });

describe('Container - registration and resolution', () => {
  let c: Container;

  beforeEach(() => {
    c = new Container();
  });

  it('registers and resolves by class (singleton default)', () => {
    c.register(Foo);
    const a = c.resolve(Foo);
    const b = c.resolve(Foo);
    expect(a).toBe(b);
  });

  it('registers with singleton=false to get new instances', () => {
    c.register(Foo, { singleton: false });
    const a = c.resolve(Foo);
    const b = c.resolve(Foo);
    expect(a).not.toBe(b);
  });

  it('registerFactory and resolve by string key', () => {
    c.registerFactory('numberFactory', makeValueFactory);
    const v1 = c.resolve<{ n: number }>('numberFactory');
    const v2 = c.resolve<{ n: number }>('numberFactory');
    // default singleton true for factories
    expect(v1).toBe(v2);
    expect(typeof v1.n).toBe('number');
  });

  it('registerFactory with singleton=false yields fresh values', () => {
    c.registerFactory('valueFactory', makeValueFactory, { singleton: false });
    const v1 = c.resolve<{ n: number }>('valueFactory');
    const v2 = c.resolve<{ n: number }>('valueFactory');
    expect(v1).not.toBe(v2);
  });

  it('has() reflects class registration, getServiceNames() lists string registrations', () => {
    c.register(Foo);
    c.registerFactory('myFactory', () => 42);
    expect(c.has(Foo)).toBe(true);
    expect(c.has('myFactory')).toBe(true);
    const names = c.getServiceNames();
    expect(names).toContain('Foo');
    expect(names).toContain('myFactory');
  });

  it('clear() removes all registrations', () => {
    c.register(Foo);
    c.registerFactory('x', () => 1);
    c.clear();
    expect(c.has(Foo)).toBe(false);
    expect(c.getServiceNames().length).toBe(0);
  });

  it('throws a helpful error when resolving an unregistered service', () => {
    expect(() => c.resolve('NotThere')).toThrow(
      "Service 'NotThere' is not registered in the DI container",
    );
  });
});

describe('Container - property injection circular detection (via nested resolve calls)', () => {
  it('detects circular dependency on resolution stack for class registrations', () => {
    // We simulate circular via factories that resolve each other
    const c = new Container();
    c.registerFactory('A', () => c.resolve('B'));
    c.registerFactory('B', () => c.resolve('A'));

    expect(() => c.resolve('A')).toThrow(/Circular dependency detected/);
  });
});

describe('Global container export utilities', () => {
  it('useContainer() returns the singleton container instance', () => {
    expect(useContainer()).toBe(globalContainer);
  });
});

describe('Container - observer pattern hooks', () => {
  it('emits register, resolve, and clear events', () => {
    const events: Array<{ type: string; payload: any }> = [];
    const c = new Container();

    c.on('registered', (payload) => events.push({ type: 'registered', payload }));
    c.on('resolved', (payload) => events.push({ type: 'resolved', payload }));
    c.on('cleared', (payload) => events.push({ type: 'cleared', payload }));

    c.register(Foo);
    c.registerFactory('value', makeValueFactory, { singleton: false });

    c.resolve(Foo);
    c.resolve('value');
    c.clear();

    expect(events.find((e) => e.type === 'registered' && e.payload.key === Foo)).toBeTruthy();
    expect(events.filter((e) => e.type === 'resolved').length).toBe(2);
    expect(events.find((e) => e.type === 'cleared')).toBeTruthy();
  });
});

describe('Container - constructor and prototype helpers', () => {
  it('construct() creates fresh instances with overrides', () => {
    class Dep {
      id = 'dep';
    }
    class NeedsOverrides {
      dep: Dep;
      name: string;
      constructor(@Component(Dep) dep: Dep, name: string) {
        this.dep = dep;
        this.name = name;
      }
    }

    const c = new Container();
    c.register(Dep);

    const instance = c.construct(NeedsOverrides, { 1: 'example' });
    expect(instance.dep).toBe(c.resolve(Dep));
    expect(instance.name).toBe('example');
    expect(c.has(NeedsOverrides)).toBe(false);
  });

  it('fork() clones registrations and optionally carries singletons', () => {
    const c = new Container();
    c.register(Foo);

    const originalFoo = c.resolve(Foo);

    const freshFork = c.fork();
    const forkFoo = freshFork.resolve(Foo);
    expect(forkFoo).not.toBe(originalFoo);

    const carriedFork = c.fork({ carrySingletons: true });
    const carriedFoo = carriedFork.resolve(Foo);
    expect(carriedFoo).toBe(originalFoo);

    freshFork.registerFactory('newFactory', () => 123);
    expect(c.has('newFactory')).toBe(false);
  });
});
