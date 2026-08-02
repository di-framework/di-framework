import { describe, expect, test } from 'bun:test';
import {
  GeneratedValue,
  GenerationType,
  getIdentities,
  getModelMetadata,
  getPrimaryId,
  Id,
  IdKind,
  isModel,
  Model,
  Repository,
} from '../src/decorators';

describe('Repository Decorator', () => {
  test('returns a class decorator function', () => {
    const decorator = Repository({ singleton: true });
    expect(typeof decorator).toBe('function');
  });

  test('accepts empty options', () => {
    const decorator = Repository();
    expect(typeof decorator).toBe('function');
  });
});

describe('Model / Id / GeneratedValue', () => {
  test('records an empty identity list when no @Id', () => {
    @Model()
    class User {
      name!: string;
    }

    expect(isModel(User)).toBe(true);
    expect(getModelMetadata(User)?.target).toBe(User);
    expect(getIdentities(User)).toEqual([]);
    expect(getPrimaryId(User)).toEqual([]);
  });

  test('@Id defaults to Primary without generation', () => {
    @Model()
    class User {
      @Id()
      id!: number;
      name!: string;
    }

    expect(getIdentities(User)).toEqual([{ propertyKey: 'id', kind: IdKind.Primary }]);
    expect(getPrimaryId(User)).toEqual([{ propertyKey: 'id', kind: IdKind.Primary }]);
  });

  test('stacked @Id + @GeneratedValue Identity', () => {
    @Model()
    class User {
      @Id()
      @GeneratedValue({ strategy: GenerationType.Identity })
      id!: number;
    }

    expect(getIdentities(User)).toEqual([
      {
        propertyKey: 'id',
        kind: IdKind.Primary,
        generated: { strategy: GenerationType.Identity },
      },
    ]);
  });

  test('@GeneratedValue without strategy defaults to Auto', () => {
    @Model()
    class User {
      @Id()
      @GeneratedValue()
      id!: number;
    }

    expect(getIdentities(User)[0]?.generated).toEqual({
      strategy: GenerationType.Auto,
    });
  });

  test('stack order does not matter', () => {
    @Model()
    class A {
      @Id()
      @GeneratedValue({ strategy: GenerationType.UUID })
      id!: string;
    }

    @Model()
    class B {
      @GeneratedValue({ strategy: GenerationType.UUID })
      @Id()
      id!: string;
    }

    expect(getIdentities(A)).toEqual(getIdentities(B));
    expect(getIdentities(A)[0]?.generated?.strategy).toBe(GenerationType.UUID);
  });

  test('multi-context identities on one model', () => {
    @Model()
    class Order {
      @Id()
      @GeneratedValue({ strategy: GenerationType.Identity })
      id!: number;

      @Id({ kind: IdKind.Tenant })
      tenantId!: string;

      @Id({ kind: IdKind.Public })
      @GeneratedValue({ strategy: GenerationType.UUID })
      publicId!: string;

      @Id({ kind: IdKind.External })
      stripePaymentIntentId!: string;

      total!: number;
    }

    const identities = getIdentities(Order);
    expect(identities).toHaveLength(4);
    expect(identities).toContainEqual({
      propertyKey: 'id',
      kind: IdKind.Primary,
      generated: { strategy: GenerationType.Identity },
    });
    expect(identities).toContainEqual({
      propertyKey: 'tenantId',
      kind: IdKind.Tenant,
    });
    expect(identities).toContainEqual({
      propertyKey: 'publicId',
      kind: IdKind.Public,
      generated: { strategy: GenerationType.UUID },
    });
    expect(identities).toContainEqual({
      propertyKey: 'stripePaymentIntentId',
      kind: IdKind.External,
    });
    expect(getPrimaryId(Order)).toEqual([
      {
        propertyKey: 'id',
        kind: IdKind.Primary,
        generated: { strategy: GenerationType.Identity },
      },
    ]);
  });

  test('composite primary key via multiple Primary fields', () => {
    @Model()
    class TenantScopedCode {
      @Id()
      tenantId!: string;

      @Id()
      code!: string;
    }

    const primary = getPrimaryId(TenantScopedCode);
    expect(primary).toHaveLength(2);
    expect(primary.map((p) => p.propertyKey).sort()).toEqual(['code', 'tenantId']);
  });

  test('@GeneratedValue without @Id throws when identities are collected', () => {
    class Broken {
      @GeneratedValue({ strategy: GenerationType.UUID })
      id!: string;
    }

    expect(() => getIdentities(Broken)).toThrow(
      /Broken\.id: @GeneratedValue requires @Id on the same property/,
    );
  });

  test('@Model fails decoration when @GeneratedValue lacks @Id', () => {
    expect(() => {
      @Model()
      class Broken {
        @GeneratedValue({ strategy: GenerationType.UUID })
        id!: string;
      }
      return Broken;
    }).toThrow(/@GeneratedValue requires @Id/);
  });

  test('isModel is false for undecorated classes', () => {
    class Plain {}
    expect(isModel(Plain)).toBe(false);
    expect(getModelMetadata(Plain)).toBeUndefined();
  });

  test('subclass inherits identities; can add more', () => {
    @Model()
    class Account {
      @Id()
      @GeneratedValue({ strategy: GenerationType.Identity })
      id!: number;
    }

    class PremiumAccount extends Account {
      @Id({ kind: IdKind.Public })
      @GeneratedValue({ strategy: GenerationType.UUID })
      publicId!: string;
    }

    expect(isModel(PremiumAccount)).toBe(true);
    expect(getIdentities(PremiumAccount)).toEqual([
      {
        propertyKey: 'id',
        kind: IdKind.Primary,
        generated: { strategy: GenerationType.Identity },
      },
      {
        propertyKey: 'publicId',
        kind: IdKind.Public,
        generated: { strategy: GenerationType.UUID },
      },
    ]);
  });

  test('GenerationType and IdKind unions accept const members and literals', () => {
    @Model()
    class Session {
      @Id({ kind: 'public' })
      @GeneratedValue({ strategy: 'uuid' })
      publicId!: string;
    }

    expect(getIdentities(Session)).toEqual([
      {
        propertyKey: 'publicId',
        kind: IdKind.Public,
        generated: { strategy: GenerationType.UUID },
      },
    ]);
  });

  test('class type works as repository entity without a separate interface', () => {
    @Model()
    class Product {
      @Id()
      @GeneratedValue({ strategy: GenerationType.Identity })
      id!: number;
      title!: string;
    }

    const row: Product = { id: 1, title: 'Widget' };
    expect(row.id).toBe(1);
    expect(getPrimaryId(Product)[0]?.propertyKey).toBe('id');
  });
});
