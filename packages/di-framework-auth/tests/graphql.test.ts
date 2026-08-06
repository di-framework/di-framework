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
  Subscription,
  setRegistry,
} from '@di-framework/graphql';
import { authorizationAllowed, authorizationDenied } from '../src/authorization.ts';
import { makeContext } from '../src/context.ts';
import { AuthError } from '../src/errors.ts';
import {
  type AuthGraphQLContext,
  createAuthContext,
  requirePrincipal,
  requireSubject,
} from '../src/graphql/context.ts';
import { Authenticated, Authorize, PublicField } from '../src/graphql/decorators.ts';
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
});

describe('domain helpers', () => {
  it('requires a principal', () => {
    expect(requirePrincipal({ principal }).sub).toBe('u1');
    expect(requireSubject({ principal })).toBe('u1');
    expect(() => requirePrincipal({})).toThrow(AuthError);
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

      @Action(() => String)
      publicAction(): string {
        return 'anyone';
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

describe('GraphQL authorization', () => {
  beforeEach(() => {
    setRegistry(new SemanticRegistry());
    useContainer().clear();
  });

  function buildAuthorizationFixture(allowed: boolean) {
    @Authorize({ resource: 'vault', action: 'read' })
    @SemanticType()
    class Vault {
      @Field(() => String)
      secret(): string {
        return 'classified';
      }
    }

    @Portal()
    class PolicyPortal {
      @Field(() => Vault)
      vault(): Vault {
        return new Vault();
      }

      @Authenticated()
      @Authorize({ action: 'loan:create' })
      @Action(() => String)
      borrow(): string {
        return 'borrowed';
      }

      @Authorize({ action: 'catalogue:list' }, { allowAnonymous: true })
      @Field(() => String)
      policyPublic(): string {
        return 'public-by-policy';
      }

      @Authorize({ action: 'events:read' })
      @Subscription('authorization.event', () => String)
      onPolicyEvent(): string {
        return 'event';
      }
    }

    const calls: Array<{ principal: unknown; context: unknown }> = [];
    const api = protectSchema(buildSemanticSchema(), {
      manager: {
        authorize(received, context) {
          calls.push({ principal: received, context });
          return allowed
            ? authorizationAllowed()
            : authorizationDenied('internal policy row 42 rejected the request');
        },
      },
    });
    return { api, calls };
  }

  it('enforces field and type decorators and passes opaque metadata', async () => {
    const { api, calls } = buildAuthorizationFixture(true);
    const result = await api.execute({
      query: '{ vault { secret } }',
      context: { principal },
    });
    expect(result.data).toEqual({ vault: { secret: 'classified' } });
    expect(calls[0]?.principal).toBe(principal);
    expect(calls[0]?.context).toMatchObject({
      transport: 'graphql',
      phase: 'resolve',
      metadata: { resource: 'vault', action: 'read' },
    });
  });

  it('composes with @Authenticated() and rejects anonymous before policy evaluation', async () => {
    const { api, calls } = buildAuthorizationFixture(true);
    const denied = await api.execute({ query: 'mutation { borrow }', context: {} });
    expect(denied.errors?.[0]?.extensions).toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(calls).toHaveLength(0);

    const allowed = await api.execute({
      query: 'mutation { borrow }',
      context: { principal },
    });
    expect(allowed.data).toEqual({ borrow: 'borrowed' });
    expect(calls).toHaveLength(1);
  });

  it('returns a generic FORBIDDEN error without leaking the policy reason', async () => {
    const { api } = buildAuthorizationFixture(false);
    const result = await api.execute({
      query: '{ vault { secret } }',
      context: { principal },
    });
    expect(result.errors?.[0]?.extensions).toMatchObject({
      code: 'FORBIDDEN',
      reason: 'access_denied',
    });
    expect(result.errors?.[0]?.message).toBe('Access denied');
    expect(result.errors?.[0]?.message).not.toContain('row 42');
  });

  it('passes undefined to managers only when anonymous evaluation is explicit', async () => {
    const { api, calls } = buildAuthorizationFixture(true);
    const result = await api.execute({ query: '{ policyPublic }', context: {} });
    expect(result.data).toEqual({ policyPublic: 'public-by-policy' });
    expect(calls[0]?.principal).toBeUndefined();
  });

  it('fails clearly when a decorated field has no manager', async () => {
    @Portal()
    class MissingManagerPortal {
      @Authorize({ action: 'missing' })
      @Field(() => String)
      protected(): string {
        return 'never';
      }
    }

    const api = protectSchema(buildSemanticSchema());
    const result = await api.execute({ query: '{ protected }', context: { principal } });
    expect(result.errors?.[0]?.message).toContain('No authorization manager registered');
  });

  it('protects subscription establishment', async () => {
    const { api, calls } = buildAuthorizationFixture(false);
    const denied = await api.subscribe({
      query: 'subscription { onPolicyEvent }',
      context: { principal },
    });
    expect(
      (denied as { errors?: readonly { extensions?: unknown }[] }).errors?.[0]?.extensions,
    ).toMatchObject({ code: 'FORBIDDEN' });
    expect(calls[0]?.context).toMatchObject({ phase: 'subscribe' });
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

  // A subscription can outlive its own access token by hours.
  it('re-checks expiry on a long-lived socket', () => {
    const expiring = createPrincipal({ sub: 'u1', method: 'bearer', expiresAt: 500 });
    expect(() => assertNotExpired(expiring, () => 100)).not.toThrow();
    expect(() => assertNotExpired(expiring, () => 1_000)).toThrow(/expired/);
    expect(() => assertNotExpired(undefined)).toThrow(AuthError);
  });
});
