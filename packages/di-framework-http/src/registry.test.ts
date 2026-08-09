import { describe, expect, it } from 'bun:test';
import { Controller, Endpoint } from '../src/decorators.ts';
import Registry, { Registry as RegistryClass } from '../src/registry.ts';

describe('HTTP Registry', () => {
  it('addTarget registers a target', () => {
    const target = class MyController {};
    Registry.addTarget(target);
    expect(Registry.getTargets().has(target)).toBe(true);
  });

  it('getTargets returns a Set of registered targets', () => {
    const targets = Registry.getTargets();
    expect(targets instanceof Set).toBe(true);
  });

  it('constructs an isolated Registry instance and clears targets', () => {
    const local = new RegistryClass();
    const target = class Isolated {};
    local.addTarget(target);
    expect(local.getTargets().has(target)).toBe(true);
    expect(Registry.getTargets().has(target)).toBe(false);
    local.clear();
    expect(local.getTargets().size).toBe(0);
  });
});

describe('HTTP decorators', () => {
  it('@Controller marks target as controller and registers it', () => {
    const target = class TestController {};
    Controller()(target);
    expect((target as any).isController).toBe(true);
  });

  it('@Endpoint without propertyKey marks the class as an endpoint', () => {
    const target = class ClassEndpoint {};
    Endpoint()(target);
    expect((target as any).isEndpoint).toBe(true);
  });
});
