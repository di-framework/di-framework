import { beforeEach, describe, expect, it } from 'bun:test';
import { useContainer } from '@di-framework/core/container';
import {
  Action,
  buildSemanticSchema,
  Ctx,
  Field,
  Portal,
  SemanticRegistry,
  SemanticType,
  setRegistry,
  Subscription,
} from '@di-framework/graphql';
import { makeContext } from '../src/context.ts';
import { AuthError } from '../src/errors.ts';
import {
  type AuthGraphQLContext,
  createAuthContext,
  getPrincipal,
  requirePrincipal,
  requireSubject,
} from '../src/graphql/context.ts';
import { Authenticated, PublicField } from '../src/graphql/decorators.ts';
import { protectSchema } from '../src/graphql/protect.ts';
import {
  assertNotExpired,
  authenticateUpgrade,
  requestFromConnectionParams,
} from '../src/graphql/ws.ts';
import { createPrincipal } from '../src/principal.ts';
import { authenticated, authFailed, noCredential } from '../src/result.ts';
import type { AuthStrategy } from '../src/types.ts';

const principal = createPrincipal({ sub: 'u1', method: 'session', amr: ['pwd'], authTime: 1_000 });

const okStrategy: AuthStrategy = {
  name: 'stub',
  authenticate: async () => authenticated(principal),
};
const anonStrategy: AuthStrategy = { name: 'stub', authenticate: async () => noCredential() };
const badStrategy: AuthStrategy = {
  name: 'stub',
  authenticate: async () => authFailed('invalid_token', 'forged token'),
};

const request = () => new Request('https://app.example.com/graphql');

describe('createAuthContext', () => {
  it('attaches the principal', async () => {
    const context = await createAuthContext({ strategy: okStrategy })(request());
    expect(context.principal?.sub).toBe('u1');
  });

  it('returns an anonymous context when no credential is present', async () => {
    expect(await createAuthContext({ strategy: anonStrategy })(request())).toEqual({});
  });

  // A rejected credential must not silently become an anonymous request.
  it('throws for a failed credential even when auth is not required', async () => {
    await expect(createAuthContext({ strategy: badStrategy })(request())).rejects.toThrow(
      AuthError,
    );
  });

  it('can require authentication up front', async () => {
    await expect(
      createAuthContext({ strategy: anonStrategy, require: true })(request()),
    ).rejects.toThrow(AuthError);
  });

  it('composes with a user-supplied context factory', async () => {
    const context = await createAuthContext({
      strategy: okStrategy,
      next: () => ({ loaders: 'built' }),
    })(request());
    expect(context['loaders']).toBe('built');
    expect(context.principal?.sub).toBe('u1');
  });

  // The graphql package keys per-request batching state on context identity, so
  // a shared object would leak one request's dataloader cache into the next.
  it('returns a fresh object per request', async () => {
    const factory = createAuthContext({ strategy: okStrategy });
    expect(await factory(request())).not.toBe(await factory(request()));
  });

  it('composes an array of strategies via chain()', async () => {
    const context = await createAuthContext({ strategy: [anonStrategy, okStrategy] })(request());
    expect(context.principal?.sub).toBe('u1');
  });
});

describe('domain helpers', () => {
  it('requires a principal', () => {
    expect(requirePrincipal({ principal }).sub).toBe('u1');
    expect(requireSubject({ principal })).toBe('u1');
    expect(() => requirePrincipal({})).toThrow(AuthError);
  });

  it('getPrincipal() reads the principal off the context without throwing', () => {
    expect(getPrincipal({ principal })).toBe(principal);
    expect(getPrincipal({})).toBeUndefined();
  });
});

describe('protectSchema', () => {
  beforeEach(() => {
    setRegistry(new SemanticRegistry());
    useContainer().clear();
  });

  /** Build a small schema with a mix of public and protected fields. */
  function buildFixture() {
    @SemanticType({ description: 'A note' })
    class Note {
      @Field(() => String)
      id!: string;

      @Field(() => String)
      title!: string;

      @Authenticated()
      @Field(() => String)
      privateNotes!: string;
    }

    @Portal()
    class NotesPortal {
      @Field(() => Note)
      publicNote(): Note {
        return Object.assign(new Note(), { id: '1', title: 'Public', privateNotes: 'secret' });
      }

      @Authenticated()
      @Field(() => String)
      whoAmI(@Ctx() context: AuthGraphQLContext): string {
        return requireSubject(context);
      }

      @Authenticated({ amr: ['mfa'] })
      @Field(() => String)
      stepUpOnly(): string {
        return 'sensitive';
      }

      @Authenticated({ maxAge: 60 })
      @Field(() => String)
      recentOnly(): string {
        return 'fresh';
      }

      @Authenticated({ acr: 'aal2' })
      @Field(() => String)
      acrGated(): string {
        return 'top-secret';
      }

      @Action(() => String)
      publicAction(): string {
        return 'anyone';
      }

      @Authenticated()
      @Subscription('protect-test.event', () => String)
      onEvent(): string {
        return 'x';
      }
    }

    return protectSchema(buildSemanticSchema(), { now: () => 1_000 });
  }

  it('leaves unmarked fields public', async () => {
    const api = buildFixture();
    const result = await api.execute({ query: '{ publicNote { id title } }', context: {} });
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ publicNote: { id: '1', title: 'Public' } });
  });

  it('rejects an unauthenticated read of a protected root field', async () => {
    const api = buildFixture();
    const result = await api.execute({ query: '{ whoAmI }', context: {} });
    expect(result.data).toBeNull();
    // graphql-js copies `extensions` off originalError, so the auth package
    // speaks the GraphQL error convention without importing graphql.
    expect(result.errors?.[0]?.extensions).toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  // graphql-js serialises `error.message` verbatim, so a raw AuthError would put
  // the detailed, log-facing message on the wire.
  it('never puts the internal message on the wire', async () => {
    const api = buildFixture();
    const result = await api.execute({ query: '{ whoAmI }', context: {} });
    expect(result.errors?.[0]?.message).toBe('Authentication required');
    expect(result.errors?.[0]?.message).not.toContain('No credential presented');
  });

  it('allows an authenticated read', async () => {
    const api = buildFixture();
    const result = await api.execute({ query: '{ whoAmI }', context: { principal } });
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ whoAmI: 'u1' });
  });

  it('protects a field on a non-root type', async () => {
    const api = buildFixture();
    const anonymous = await api.execute({ query: '{ publicNote { privateNotes } }', context: {} });
    expect(anonymous.errors?.[0]?.extensions).toMatchObject({ code: 'UNAUTHENTICATED' });

    const authed = await api.execute({
      query: '{ publicNote { privateNotes } }',
      context: { principal },
    });
    expect(authed.data).toEqual({ publicNote: { privateNotes: 'secret' } });
  });

  // Still authentication, not authorization: how the subject proved identity,
  // and how recently.
  it('enforces an amr requirement', async () => {
    const api = buildFixture();
    const weak = await api.execute({ query: '{ stepUpOnly }', context: { principal } });
    expect(weak.errors?.[0]?.message).toBe('Stronger authentication required');

    const strong = await api.execute({
      query: '{ stepUpOnly }',
      context: { principal: createPrincipal({ sub: 'u1', method: 'webauthn', amr: ['mfa'] }) },
    });
    expect(strong.data).toEqual({ stepUpOnly: 'sensitive' });
  });

  it('enforces a maxAge requirement', async () => {
    const api = buildFixture();
    const stale = await api.execute({
      query: '{ recentOnly }',
      context: { principal: createPrincipal({ sub: 'u1', method: 'session', authTime: 1 }) },
    });
    expect(stale.errors?.[0]?.message).toBe('Please re-authenticate');

    const fresh = await api.execute({
      query: '{ recentOnly }',
      context: { principal: createPrincipal({ sub: 'u1', method: 'session', authTime: 990 }) },
    });
    expect(fresh.data).toEqual({ recentOnly: 'fresh' });
  });

  it('enforces an acr requirement', async () => {
    const api = buildFixture();
    const weak = await api.execute({
      query: '{ acrGated }',
      context: { principal: createPrincipal({ sub: 'u1', method: 'webauthn', acr: 'aal1' }) },
    });
    expect(weak.errors?.[0]?.message).toBe('Stronger authentication required');

    const strong = await api.execute({
      query: '{ acrGated }',
      context: { principal: createPrincipal({ sub: 'u1', method: 'webauthn', acr: 'aal2' }) },
    });
    expect(strong.data).toEqual({ acrGated: 'top-secret' });
  });

  // Subscriptions must be refused before the event stream opens, not per payload.
  it('protects a subscription root field by wrapping subscribe', async () => {
    const api = buildFixture();
    const denied = await api.subscribe({
      query: 'subscription { onEvent }',
      context: {},
    });
    const errors = (denied as { errors?: readonly unknown[] }).errors;
    expect(errors?.[0]).toMatchObject({ extensions: { code: 'UNAUTHENTICATED' } });
  });

  it('protects mutations too', async () => {
    setRegistry(new SemanticRegistry());
    useContainer().clear();

    @Portal()
    class Admin {
      @Authenticated()
      @Action(() => String)
      dangerous(): string {
        return 'done';
      }
    }

    const api = protectSchema(buildSemanticSchema());
    const denied = await api.execute({ query: 'mutation { dangerous }', context: {} });
    expect(denied.errors?.[0]?.extensions).toMatchObject({ code: 'UNAUTHENTICATED' });
    const allowed = await api.execute({ query: 'mutation { dangerous }', context: { principal } });
    expect(allowed.data).toEqual({ dangerous: 'done' });
  });

  // Exercises the wall-clock default for `now` (no `now` option supplied).
  it('falls back to the wall clock when protectSchema is not given an explicit now', async () => {
    setRegistry(new SemanticRegistry());
    useContainer().clear();

    @Portal()
    class Recent {
      @Authenticated({ maxAge: 3_600 })
      @Field(() => String)
      recentOnly(): string {
        return 'fresh';
      }
    }

    const api = protectSchema(buildSemanticSchema());
    const now = Math.floor(Date.now() / 1000);
    const allowed = await api.execute({
      query: '{ recentOnly }',
      context: { principal: createPrincipal({ sub: 'u1', method: 'session', authTime: now }) },
    });
    expect(allowed.data).toEqual({ recentOnly: 'fresh' });
  });

  it('applies a class-level @Authenticated() to every field of the type', async () => {
    setRegistry(new SemanticRegistry());
    useContainer().clear();

    @Authenticated()
    @SemanticType({ description: 'Only for authenticated readers' })
    class Vault {
      @Field(() => String)
      combination(): string {
        return '12-34-56';
      }
    }

    @Portal()
    class VaultPortal {
      @Field(() => Vault)
      vault(): Vault {
        return new Vault();
      }
    }

    const api = protectSchema(buildSemanticSchema());
    const denied = await api.execute({ query: '{ vault { combination } }', context: {} });
    expect(denied.errors?.[0]?.extensions).toMatchObject({ code: 'UNAUTHENTICATED' });

    const allowed = await api.execute({
      query: '{ vault { combination } }',
      context: { principal },
    });
    expect(allowed.data).toEqual({ vault: { combination: '12-34-56' } });
  });

  it('can default every field to protected', async () => {
    setRegistry(new SemanticRegistry());
    useContainer().clear();

    @Portal()
    class Everything {
      @Field(() => String)
      secret(): string {
        return 'hidden';
      }

      @PublicField()
      @Field(() => String)
      health(): string {
        return 'ok';
      }
    }

    const api = protectSchema(buildSemanticSchema(), { default: 'authenticated' });
    expect(
      (await api.execute({ query: '{ secret }', context: {} })).errors?.[0]?.extensions,
    ).toMatchObject({ code: 'UNAUTHENTICATED' });
    expect((await api.execute({ query: '{ health }', context: {} })).data).toEqual({
      health: 'ok',
    });
  });
});

describe('WebSocket authentication', () => {
  it('reads a bearer token from connection_init', () => {
    const built = requestFromConnectionParams({ authorization: 'Bearer abc' });
    expect(built.headers.get('authorization')).toBe('Bearer abc');

    const bare = requestFromConnectionParams({ token: 'abc' });
    expect(bare.headers.get('authorization')).toBe('Bearer abc');
  });

  it('carries a cookie and API key through', () => {
    const built = requestFromConnectionParams({ cookie: '__Host-sid=x', apiKey: 'k' });
    expect(built.headers.get('cookie')).toBe('__Host-sid=x');
    expect(built.headers.get('x-api-key')).toBe('k');
  });

  it('authenticates an upgrade', async () => {
    expect((await authenticateUpgrade({}, { strategy: okStrategy })).principal?.sub).toBe('u1');
    await expect(authenticateUpgrade({}, { strategy: anonStrategy })).rejects.toThrow(AuthError);
    await expect(
      authenticateUpgrade({}, { strategy: anonStrategy, require: false }),
    ).resolves.toEqual({});
  });

  it('composes an array of strategies via chain()', async () => {
    expect(
      (await authenticateUpgrade({}, { strategy: [anonStrategy, okStrategy] })).principal?.sub,
    ).toBe('u1');
  });

  // A subscription can outlive its own access token by hours.
  it('re-checks expiry on a long-lived socket', () => {
    const expiring = createPrincipal({ sub: 'u1', method: 'bearer', expiresAt: 500 });
    expect(() => assertNotExpired(expiring, () => 100)).not.toThrow();
    expect(() => assertNotExpired(expiring, () => 1_000)).toThrow(/expired/);
    expect(() => assertNotExpired(undefined)).toThrow(AuthError);
  });

  it('re-checks expiry using the wall-clock default when no `now` is supplied', () => {
    const notExpiring = createPrincipal({ sub: 'u1', method: 'bearer' });
    expect(() => assertNotExpired(notExpiring)).not.toThrow();
  });
});
