import { describe, expect, it } from 'bun:test';
import {
  Action,
  Arg,
  BoundedContext,
  Extends,
  Field,
  InputType,
  Lookup,
  Portal,
  SemanticType,
} from '../src/decorators.ts';
import { SemanticBoundaryError } from '../src/errors.ts';
import { ID } from '../src/scalars.ts';
import { buildTypeGraph } from '../src/type-graph.ts';
import { withRegistry } from './helpers.ts';

describe('semantic boundaries', () => {
  it('rejects a cross-context reference to a type that is not a boundary', () => {
    withRegistry((registry) => {
      @BoundedContext('Billing')
      @SemanticType()
      class Ledger {
        @Field(() => String)
        balance(): string {
          return '0';
        }
      }

      @BoundedContext('Support')
      @SemanticType()
      class Ticket {
        @Field(() => Ledger)
        ledger(): Ledger {
          return new Ledger();
        }
      }

      expect(() => buildTypeGraph({ registry })).toThrow(SemanticBoundaryError);
      expect(() => buildTypeGraph({ registry })).toThrow(/not a boundary type/);
    });
  });

  it('allows the same reference once the type declares a boundary', () => {
    withRegistry((registry) => {
      @BoundedContext('Billing')
      @SemanticType({ boundary: true, key: 'id' })
      class OpenLedger {
        id!: string;
      }

      @BoundedContext('Support')
      @SemanticType()
      class OpenTicket {
        @Field(() => OpenLedger)
        ledger(): OpenLedger {
          return new OpenLedger();
        }
      }

      const graph = buildTypeGraph({ registry });
      expect(graph.objects.map((object) => object.name).sort()).toEqual([
        'OpenLedger',
        'OpenTicket',
      ]);
    });
  });

  it('allows references inside a single context', () => {
    withRegistry((registry) => {
      @BoundedContext('Catalog')
      @SemanticType()
      class Price {
        @Field(() => String)
        amount(): string {
          return '1';
        }
      }

      @BoundedContext('Catalog')
      @SemanticType()
      class Product {
        @Field(() => Price)
        price(): Price {
          return new Price();
        }
      }

      expect(() => buildTypeGraph({ registry })).not.toThrow();
    });
  });

  it('can be turned off while migrating', () => {
    withRegistry((registry) => {
      @BoundedContext('Left')
      @SemanticType()
      class Closed {
        @Field(() => String)
        value(): string {
          return '';
        }
      }

      @BoundedContext('Right')
      @SemanticType()
      class Reacher {
        @Field(() => Closed)
        closed(): Closed {
          return new Closed();
        }
      }

      expect(() => buildTypeGraph({ registry, enforceBoundaries: false })).not.toThrow();
    });
  });

  it('rejects an extension of a type owned by another context', () => {
    withRegistry((registry) => {
      @BoundedContext('Inventory')
      @SemanticType()
      class Warehouse {
        @Field(() => String)
        code(): string {
          return 'w1';
        }
      }

      @BoundedContext('Shipping')
      @Extends(() => Warehouse)
      class WarehouseRoutes {
        @Field(() => String)
        route(): string {
          return 'r1';
        }
      }

      expect(() => buildTypeGraph({ registry })).toThrow(SemanticBoundaryError);
    });
  });

  it('rejects an extension that redefines an existing field', () => {
    withRegistry((registry) => {
      @BoundedContext('Core')
      @SemanticType({ boundary: true, key: 'id' })
      class Account {
        @Field(() => String)
        label(): string {
          return 'a';
        }
      }

      @BoundedContext('Addon')
      @Extends(() => Account)
      class AccountLabel {
        @Field(() => String)
        label(): string {
          return 'b';
        }
      }

      expect(() => buildTypeGraph({ registry })).toThrow(/already exists/);
    });
  });

  it('requires a key on boundary types', () => {
    withRegistry(() => {
      expect(() => {
        @SemanticType({ boundary: true })
        class Keyless {}
        return Keyless;
      }).toThrow(/must declare a key/);
    });
  });

  it('requires a @Lookup for actions declared on a type', () => {
    withRegistry((registry) => {
      @SemanticType({ key: 'id' })
      class Invoice {
        id!: string;

        @Action(() => String)
        void_(): string {
          return 'voided';
        }
      }

      expect(() => buildTypeGraph({ registry })).toThrow(/@Lookup/);
    });
  });

  it('reports the entity actions it can wire', () => {
    withRegistry((registry) => {
      @SemanticType({ key: 'reference', keyType: () => ID })
      class Shipment {
        reference!: string;

        @Lookup()
        static load(reference: string) {
          return { reference };
        }

        @Action(() => String)
        dispatch(): string {
          return 'dispatched';
        }
      }

      const graph = buildTypeGraph({ registry });
      const mutation = graph.mutation?.fields[0];
      expect(mutation?.name).toBe('shipmentDispatch');
      expect(mutation?.args.map((arg) => arg.name)).toEqual(['reference']);
    });
  });

  it('rejects a portal used as a field type', () => {
    withRegistry((registry) => {
      @Portal()
      class RootPortal {
        @Field(() => String)
        ping(): string {
          return 'pong';
        }
      }

      @SemanticType()
      class Holder {
        @Field(() => RootPortal)
        root(): RootPortal {
          return new RootPortal();
        }
      }

      expect(() => buildTypeGraph({ registry })).toThrow(/cannot be used as a field type/);
    });
  });

  it('rejects input types with no fields', () => {
    withRegistry((registry) => {
      @InputType()
      class EmptyInput {}

      @Portal()
      class EmptyInputPortal {
        @Field(() => String)
        echo(@Arg('value', () => EmptyInput) _value: EmptyInput): string {
          return 'x';
        }
      }

      expect(() => buildTypeGraph({ registry })).toThrow(/at least one @Field/);
    });
  });
});
