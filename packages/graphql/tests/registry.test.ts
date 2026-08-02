import { describe, expect, it } from 'bun:test';
import { SemanticRegistry, setRegistry } from '../src/registry.ts';
import { withRegistry } from './helpers.ts';

describe('SemanticRegistry', () => {
  it('getTypes returns all registered types', () => {
    withRegistry((registry) => {
      expect(registry.getTypes()).toEqual([]);

      registry.registerType({
        target: class Foo {},
        name: 'Foo',
        options: {},
        portal: false,
      });

      const types = registry.getTypes();
      expect(types).toHaveLength(1);
      expect(types[0]!.name).toBe('Foo');
    });
  });

  it('getInputs returns all registered input types', () => {
    withRegistry((registry) => {
      expect(registry.getInputs()).toEqual([]);

      registry.registerInput({
        target: class FooInput {},
        name: 'FooInput',
        options: {},
      });

      const inputs = registry.getInputs();
      expect(inputs).toHaveLength(1);
      expect(inputs[0]!.name).toBe('FooInput');
    });
  });

  it('getEnums returns all registered enums', () => {
    withRegistry((registry) => {
      expect(registry.getEnums()).toEqual([]);

      registry.registerEnum({
        target: { A: 'A', B: 'B' } as any,
        name: 'MyEnum',
        description: 'An enum',
      });

      const enums = registry.getEnums();
      expect(enums).toHaveLength(1);
      expect(enums[0]!.name).toBe('MyEnum');
    });
  });

  it('getExtensions returns all registered extensions', () => {
    withRegistry((registry) => {
      expect(registry.getExtensions()).toEqual([]);

      registry.registerExtension({
        target: class Extension {},
        extended: () => class Base {},
        context: 'Ctx',
      });

      const exts = registry.getExtensions();
      expect(exts).toHaveLength(1);
    });
  });

  it('getContexts returns unique context names from types and extensions', () => {
    withRegistry((registry) => {
      registry.registerType({
        target: class TypeA {},
        name: 'TypeA',
        options: {},
        context: 'Billing',
        portal: false,
      });

      registry.registerExtension({
        target: class ExtB {},
        extended: () => class Base {},
        context: 'Shipping',
      });

      registry.registerType({
        target: class TypeC {},
        name: 'TypeC',
        options: {},
        context: 'Billing',
        portal: false,
      });

      const contexts = registry.getContexts();
      expect(contexts).toContain('Billing');
      expect(contexts).toContain('Shipping');
      expect(contexts).toHaveLength(2);
    });
  });

  it('fork clones all registrations into a new registry', () => {
    withRegistry((registry) => {
      registry.registerType({
        target: class Forked {},
        name: 'Forked',
        options: {},
        context: 'Ctx',
        portal: false,
      });

      const clone = registry.fork();
      expect(clone.getTypes()).toHaveLength(1);
      expect(clone.getTypes()[0]!.name).toBe('Forked');
    });
  });

  it('fork does not share mutable state with the original', () => {
    withRegistry((registry) => {
      registry.registerType({
        target: class Original {},
        name: 'Original',
        options: {},
        portal: false,
      });

      const clone = registry.fork();
      clone.clear();

      expect(registry.getTypes()).toHaveLength(1);
      expect(clone.getTypes()).toHaveLength(0);
    });
  });

  it('clear removes all registrations', () => {
    withRegistry((registry) => {
      registry.registerType({
        target: class ClearMe {},
        name: 'ClearMe',
        options: {},
        portal: false,
      });
      registry.registerInput({
        target: class ClearInput {},
        name: 'ClearInput',
        options: {},
      });
      registry.registerEnum({
        target: { X: 'X' } as any,
        name: 'ClearEnum',
      });
      registry.registerExtension({
        target: class ClearExt {},
        extended: () => class Base {},
      });

      expect(registry.getTypes()).toHaveLength(1);
      expect(registry.getInputs()).toHaveLength(1);
      expect(registry.getEnums()).toHaveLength(1);
      expect(registry.getExtensions()).toHaveLength(1);

      registry.clear();

      expect(registry.getTypes()).toHaveLength(0);
      expect(registry.getInputs()).toHaveLength(0);
      expect(registry.getEnums()).toHaveLength(0);
      expect(registry.getExtensions()).toHaveLength(0);
    });
  });
});

describe('getRegistry bootstrap', () => {
  it('creates a fresh process registry when the global key is missing', async () => {
    const { getRegistry, setRegistry, SemanticRegistry } = await import('../src/registry.ts');
    const KEY = Symbol.for('@di-framework/graphql-registry');
    const previous = (globalThis as any)[KEY];
    try {
      delete (globalThis as any)[KEY];
      const created = getRegistry();
      expect(created).toBeInstanceOf(SemanticRegistry);
      expect(getRegistry()).toBe(created);
    } finally {
      (globalThis as any)[KEY] = previous ?? new SemanticRegistry();
      // Keep the suite's domain registry in place if tests already swapped it.
      if (previous) setRegistry(previous);
    }
  });
});
