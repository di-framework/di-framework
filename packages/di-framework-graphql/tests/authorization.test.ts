/**
 * `@Requires`: role, claim and predicate enforcement on fields, actions,
 * portal roots and whole types — plus what a denied caller is allowed to learn.
 */

import { describe, expect, it } from 'bun:test';
import { Container } from '@di-framework/core/container';
import { evaluateRequirements, SemanticAuthorizationError } from '../src/authorization.ts';
import {
  Action,
  Arg,
  Ctx,
  Field,
  Lookup,
  Portal,
  Requires,
  SemanticType,
} from '../src/decorators.ts';
import { ID } from '../src/scalars.ts';
import { buildSemanticSchema } from '../src/schema.ts';
import { withRegistry } from './helpers.ts';

function librarySchema() {
  @SemanticType({ key: 'id' })
  class Book {
    id!: string;
    ownerId!: string;

    @Field(() => String) title!: string;

    // Guarded fields are nullable: a permission failure should blank the field,
    // not null the whole book.
    @Requires({ roles: ['librarian'] })
    @Field(() => String, { nullable: true })
    acquisitionCost(): string {
      return '£42.00';
    }

    @Requires({ predicate: ({ parent, ctx }) => (parent as Book).ownerId === ctx.user?.id })
    @Field(() => String, { nullable: true })
    privateNote(): string {
      return 'reserved for staff';
    }

    @Requires({ roles: ['librarian'] })
    @Action(() => String, { nullable: true })
    withdraw(): string {
      return `withdrew ${this.id}`;
    }

    @Lookup()
    static load(id: string) {
      return Object.assign(new Book(), { id, ownerId: 'u1', title: 'Dune' });
    }
  }

  @Portal()
  class Query {
    @Field(() => Book)
    book(): Book {
      return Book.load('b1');
    }

    @Requires({ authenticated: true })
    @Field(() => String, { nullable: true })
    whoami(@Ctx() ctx: any): string {
      return ctx.user.id;
    }

    @Requires({ claims: { tenant: ['acme', 'globex'] } })
    @Field(() => String, { nullable: true })
    tenantSecret(): string {
      return 'secret';
    }

    @Requires({ roles: ['admin'], message: 'Admins only.' })
    @Action(() => String, { nullable: true })
    purge(@Arg('scope', () => String) scope: string): string {
      return `purged ${scope}`;
    }

    /** Non-null on purpose, to pin down how a denial propagates. */
    @Requires({ roles: ['admin'] })
    @Field(() => String)
    strictSecret(): string {
      return 'secret';
    }
  }

  return buildSemanticSchema({ container: new Container() });
}

describe('@Requires on fields', () => {
  it('allows a caller holding the required role', async () => {
    const api = withRegistry(librarySchema);
    const result = await api.execute({
      query: '{ book { title acquisitionCost } }',
      context: { user: { id: 'u9', roles: ['librarian'] } },
    });
    expect(result.errors).toBeUndefined();
    expect(result.data?.book).toEqual({ title: 'Dune', acquisitionCost: '£42.00' });
  });

  it('denies a caller without the role but still serves unguarded fields', async () => {
    const api = withRegistry(librarySchema);
    const result = await api.execute({
      query: '{ book { title acquisitionCost } }',
      context: { user: { id: 'u9', roles: ['member'] } },
    });
    expect(result.errors?.[0]?.message).toBe('Not authorized.');
    expect(result.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
    expect(result.data?.book).toEqual({ title: 'Dune', acquisitionCost: null });
  });

  it('nulls the parent when a denied field is non-null', async () => {
    const api = withRegistry(librarySchema);
    const result = await api.execute({
      query: '{ strictSecret }',
      context: { user: { id: 'u9', roles: ['member'] } },
    });
    expect(result.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
    // Standard GraphQL non-null propagation — declare guarded fields nullable
    // unless blanking the whole selection is what you want.
    expect(result.data).toBeNull();
  });

  it('distinguishes anonymous callers with UNAUTHENTICATED', async () => {
    const api = withRegistry(librarySchema);
    const result = await api.execute({ query: '{ whoami }', context: {} });
    expect(result.errors?.[0]?.extensions?.code).toBe('UNAUTHENTICATED');
    expect(result.errors?.[0]?.message).toBe('Authentication is required.');
  });

  it('evaluates predicates against the parent object', async () => {
    const api = withRegistry(librarySchema);
    const owner = await api.execute({
      query: '{ book { privateNote } }',
      context: { user: { id: 'u1' } },
    });
    expect(owner.data?.book).toEqual({ privateNote: 'reserved for staff' });

    const other = await withRegistry(librarySchema).execute({
      query: '{ book { privateNote } }',
      context: { user: { id: 'u2' } },
    });
    expect(other.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
  });

  it('matches a claim against any value in the allowed list', async () => {
    const allowed = await withRegistry(librarySchema).execute({
      query: '{ tenantSecret }',
      context: { user: { id: 'u1', claims: { tenant: 'globex' } } },
    });
    expect(allowed.data?.tenantSecret).toBe('secret');

    const denied = await withRegistry(librarySchema).execute({
      query: '{ tenantSecret }',
      context: { user: { id: 'u1', claims: { tenant: 'initech' } } },
    });
    expect(denied.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
  });
});

describe('@Requires on actions', () => {
  it('guards a portal mutation and surfaces the declared message', async () => {
    const denied = await withRegistry(librarySchema).execute({
      query: 'mutation { purge(scope: "all") }',
      context: { user: { id: 'u1', roles: ['member'] } },
    });
    expect(denied.errors?.[0]?.message).toBe('Admins only.');
    expect(denied.data?.purge).toBeNull();

    const allowed = await withRegistry(librarySchema).execute({
      query: 'mutation { purge(scope: "all") }',
      context: { user: { id: 'u1', roles: ['admin'] } },
    });
    expect(allowed.data?.purge).toBe('purged all');
  });

  it('guards an entity action before the entity is loaded', async () => {
    let loads = 0;
    const api = withRegistry(() => {
      @SemanticType({ key: 'id' })
      class Vault {
        id!: string;

        @Field(() => String) label!: string;

        @Requires({ roles: ['keyholder'] })
        @Action(() => String)
        open(): string {
          return 'opened';
        }

        @Lookup()
        static load(id: string) {
          loads += 1;
          return Object.assign(new Vault(), { id, label: 'v' });
        }
      }

      @Portal()
      class Query {
        @Field(() => Vault)
        vault(): Vault {
          return Vault.load('v1');
        }
      }

      return buildSemanticSchema({ container: new Container() });
    });

    loads = 0;
    const denied = await api.execute({
      query: 'mutation { vaultOpen(id: "v1") }',
      context: { user: { id: 'u1', roles: [] } },
    });
    expect(denied.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
    // The domain object is never even loaded for a denied caller.
    expect(loads).toBe(0);
  });
});

describe('@Requires on a whole type', () => {
  it('guards every field of the class it is applied to', async () => {
    const api = withRegistry(() => {
      @Requires({ roles: ['staff'] })
      @Portal()
      class AdminQuery {
        @Field(() => String, { nullable: true })
        metrics(): string {
          return 'ok';
        }

        @Field(() => ID, { nullable: true })
        buildId(): string {
          return 'b1';
        }
      }

      return buildSemanticSchema({ container: new Container() });
    });

    const denied = await api.execute({ query: '{ metrics buildId }', context: { user: {} } });
    expect(denied.errors).toHaveLength(2);
    expect(denied.errors?.every((e) => e.extensions?.code === 'FORBIDDEN')).toBe(true);

    const allowed = await withRegistry(() => {
      @Requires({ roles: ['staff'] })
      @Portal()
      class AdminQuery {
        @Field(() => String, { nullable: true })
        metrics(): string {
          return 'ok';
        }
      }
      return buildSemanticSchema({ container: new Container() });
    }).execute({ query: '{ metrics }', context: { user: { roles: ['staff'] } } });
    expect(allowed.data?.metrics).toBe('ok');
  });
});

describe('authorization wiring', () => {
  it('honours a custom principal reader and onDenied hook', async () => {
    const api = withRegistry(() => {
      @Portal()
      class Query {
        @Requires({ roles: ['ops'] })
        @Field(() => String)
        restricted(): string {
          return 'ok';
        }
      }

      return buildSemanticSchema({
        container: new Container(),
        authorization: {
          principal: (ctx) => ctx.session,
          roles: (_ctx, principal: any) => principal?.grants ?? [],
          onDenied: () => new SemanticAuthorizationError('Nope.', 'DENIED'),
        },
      });
    });

    const allowed = await api.execute({
      query: '{ restricted }',
      context: { session: { grants: ['ops'] } },
    });
    expect(allowed.data?.restricted).toBe('ok');

    const denied = await api.execute({
      query: '{ restricted }',
      context: { session: { grants: ['dev'] } },
    });
    expect(denied.errors?.[0]?.message).toBe('Nope.');
    expect(denied.errors?.[0]?.extensions?.code).toBe('DENIED');
  });

  it('leaks nothing about the rule that failed', async () => {
    const denied = await withRegistry(librarySchema).execute({
      query: '{ book { acquisitionCost } }',
      context: { user: { id: 'u9', roles: ['member'] } },
    });
    const serialized = JSON.stringify(denied.errors);
    expect(serialized).not.toContain('librarian');
    expect(serialized).not.toContain('roles');
    expect(serialized).not.toContain('acquisitionCost:');
  });

  it('treats multiple requirements as conjunctive', async () => {
    const context = { parent: undefined, args: {}, ctx: { user: { roles: ['a'] } }, info: {} };
    expect(
      await evaluateRequirements([{ roles: ['a'] }, { roles: ['b'] }], 'X.y', context),
    ).toMatchObject({ reason: 'roles' });
    expect(await evaluateRequirements([{ roles: ['a'] }], 'X.y', context)).toBeNull();
  });

  it('requires every role when allRoles is used', async () => {
    const context = { parent: undefined, args: {}, ctx: { user: { roles: ['a'] } }, info: {} };
    expect(await evaluateRequirements([{ allRoles: ['a', 'b'] }], 'X.y', context)).toMatchObject({
      reason: 'roles',
    });
    context.ctx.user.roles = ['a', 'b'];
    expect(await evaluateRequirements([{ allRoles: ['a', 'b'] }], 'X.y', context)).toBeNull();
  });
});
