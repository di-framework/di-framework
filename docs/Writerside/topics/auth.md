# Authentication

Authentication for di-framework — server sessions, JWT/JWS bearer tokens, OAuth2/OIDC sign-in, and WebAuthn passkeys. Built entirely on the Web Cryptography API with **zero runtime dependencies**, so the same code runs on Bun, Node 20+, Deno, and Cloudflare Workers.

Domain services stay on `@di-framework/core`; this package is the authentication and authorization integration layer.

## Features

- **Password + server sessions**: NIST SP 800-63B password policy, PBKDF2-HMAC-SHA-256 hashing, opaque session tokens stored hashed, `__Host-` cookies, absolute and inactivity timeouts, regeneration on login, signed double-submit CSRF.
- **JWT / JWS bearer tokens**: compact JWS over WebCrypto with a mandatory algorithm allowlist, `kid` and JWKS publishing, overlapping key rotation, and opaque refresh tokens with rotation and reuse detection.
- **OAuth2 / OIDC relying party**: Authorization Code with mandatory PKCE S256, discovery, `state` + `nonce` binding, ID-token validation, and presets for Google, Microsoft Entra, GitHub, and any compliant OIDC provider.
- **WebAuthn passkeys**: W3C WebAuthn Level 3 registration and authentication, including a CTAP2-canonical CBOR decoder and COSE key handling, with no dependencies.
- **Provider pattern throughout**: strategies and storage are plain interfaces with factory-function implementations. In-memory stores ship for development; a bridge over `@di-framework/repo`'s `StorageAdapter` covers real backends.
- **First-class HTTP and GraphQL guards**: a typed `req.principal` for `@di-framework/http`, and an `@Authenticated()` decorator plus `protectSchema()` for `@di-framework/graphql`.
- **Pluggable authorization**: an `AuthorizationManager` hook with opaque policy metadata, `requireAuthz()` for HTTP, and `@Authorize()` for GraphQL. Policies remain application-owned and can live in OPA, SpiceDB, SQL, or an in-process manager.
- **Optional declarative policies**: [`@di-framework/authz`](authorization.md) builds on that generic boundary with resource policies and fail-closed controller binding; it is a separate companion package.

## Installation

```bash
bun add @di-framework/auth @di-framework/core
# optional integrations
bun add @di-framework/http @di-framework/graphql @di-framework/repo
```

```bash
npm install @di-framework/auth @di-framework/core
```

Decorators need TypeScript 5 and `experimentalDecorators`. `emitDecoratorMetadata` is not required.

## Quick Start

```ts
import { registerAuth } from '@di-framework/auth';
import { requireAuth, withAuthErrors, withAuthRoutes } from '@di-framework/auth/http';
import { TypedRouter, json } from '@di-framework/http';

const auth = registerAuth({
  // At least 32 bytes. HKDF-expanded into the CSRF and cookie keys.
  secret: process.env.AUTH_SECRET!,
  jwt: { issuer: 'https://api.example.com', audience: 'api' },
});

await auth.passwords.createUser({
  identifier: 'ada@example.com',
  password: 'correct horse battery staple',
});

const router = TypedRouter({ catch: withAuthErrors() });
const secure = withAuthRoutes(router);

router.get('/health', () => json({ ok: true }));

// `req.principal` is typed as Principal, not any.
secure.get('/me', (req) => json({ sub: req.principal.sub }));
```

## Core Concepts

### Strategies

An `AuthStrategy` answers one question: does this request carry a credential of my kind, and is it valid? Strategies are factory functions returning object literals, the same shape `@di-framework/events` uses for transports.

```ts
import { authenticated, authFailed, chain, createPrincipal, noCredential } from '@di-framework/auth';

function headerStrategy(users: UserStore): AuthStrategy {
  return {
    name: 'x-user',
    async authenticate({ request }) {
      const id = request.headers.get('x-user-id');
      if (!id) return noCredential();                 // not mine — try the next
      const user = await users.findById(id);
      if (!user) return authFailed('invalid_credentials', `No user '${id}'`);  // mine, and bad — stop
      return authenticated(createPrincipal({ sub: user.id, method: 'api-key' }));
    },
  };
}

const strategy = chain([sessionStrategy, bearerStrategy, headerStrategy(users)]);
```

The three-state result is deliberate. `no-credential` means try the next strategy; `failed` halts the chain. Without that distinction, a forged bearer token falls through and the request ends up anonymous rather than rejected.

### Principal

```ts
interface Principal {
  sub: string;              // stable subject id
  method: AuthMethod;       // how they proved it on this request
  amr?: readonly string[];  // RFC 8176 methods, e.g. ['hwk', 'user', 'mfa']
  acr?: string;
  authTime: number;         // when the original authentication happened
  scope?: readonly string[];
  sessionId?: string;
  claims?: Record<string, unknown>;
}
```

### Authorization managers

`AuthorizationManager` is the policy decision point; it does not impose a role or permission model. It receives the authenticated `Principal` and a transport context containing application-defined metadata. For policies that explicitly allow anonymous evaluation, the principal can be `undefined`.

The following example adapts an Open Policy Agent endpoint. The same interface can wrap SpiceDB, SQL, or an in-process policy engine.

```ts
import {
  type AuthorizationManager,
  authorizationAllowed,
  authorizationDenied,
  registerAuth,
} from '@di-framework/auth';

const authorization: AuthorizationManager = {
  async authorize(principal, context) {
    const response = await fetch('https://opa.example.com/v1/data/library/allow', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        input: {
          principal: principal ? { sub: principal.sub, scope: principal.scope } : null,
          metadata: context.metadata,
          transport: context.transport,
        },
      }),
    });

    if (!response.ok) {
      return authorizationDenied(`Policy agent returned HTTP ${response.status}`);
    }

    const decision = await response.json() as { result?: unknown };
    return decision.result === true
      ? authorizationAllowed()
      : authorizationDenied('Policy agent returned a non-allow decision');
  },
};

registerAuth({ secret, authorization });
```

Denial reasons are retained for application logging but are never exposed to clients. Unless a guard supplies its own `manager`, HTTP and GraphQL resolve the manager registered under `auth.AuthorizationManager` by `registerAuth`.

## HTTP

```ts
import { TypedRouter, json } from '@di-framework/http';
import {
  applyAuthHeaders, createAuthRoutes, mountAuthRoutes,
  requireAuth, requireAuthz, secured, securitySchemesFor, withAuthErrors, withAuthRoutes,
} from '@di-framework/auth/http';

const router = TypedRouter({
  before: [requireAuth()],          // or guard per route, below
  catch: withAuthErrors(),
  finally: [applyAuthHeaders],      // applies cookies a guard queued
});
```

Per-route protection, which types the principal:

```ts
const secure = withAuthRoutes(router);

@Controller()
export class MeController {
  @Endpoint({ summary: 'Current principal', security: secured('bearerAuth') })
  static get = secure.get('/me', async (req) => {
    const controller = useContainer().resolve(MeController);
    return json(await controller.load(req.principal.sub));
  });
}
```

Escape hatches: `{ auth: false }` for a public route, `{ auth: { mode: 'optional' } }` to attach a principal when present.

Add authorization metadata to a protected route. Authentication runs first, then the registered manager decides whether the principal may perform the action:

```ts
secure.get('/admin', (req) => json({ subject: req.principal.sub }), {
  authorization: { metadata: { resource: 'admin', action: 'read' } },
});
```

When composing route middleware directly, keep the same order:

```ts
router.get('/admin', handler, {
  use: [requireAuth(), requireAuthz({ metadata: { action: 'admin:read' } })],
});
```

By default, `requireAuthz()` returns 401 when no principal is present. Set `allowAnonymous: true` only for a manager that intentionally evaluates public-policy requests. A policy denial produces a generic 403 response with the `access_denied` code; its internal reason stays redacted.

### Mountable auth routes

```ts
const authRouter = createAuthRoutes({ oauth: { google: googleClient } });
mountAuthRoutes(router, authRouter, '/auth');
```

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/auth/register` | Creates a user and signs them in. |
| `POST` | `/auth/login` | Regenerates the session id — the fixation defence. |
| `POST` | `/auth/logout` | Idempotent; clears cookies server-side and on the client. |
| `POST` | `/auth/refresh` | Rotates the refresh token; reuse revokes the family. |
| `GET` | `/auth/session` | Whoami. Never echoes raw claims. |
| `GET` | `/auth/csrf` | A token bound to the current session. |
| `POST` | `/auth/webauthn/{register,login}/{options,verify}` | Challenge stored server-side, single-use. |
| `GET` | `/auth/oauth/:provider/{start,callback}` | PKCE and single-use `state`. |

### OpenAPI

```ts
const spec = generateOpenAPI({
  title: 'API',
  securitySchemes: securitySchemesFor([auth.strategy]),
  security: secured('bearerAuth'),   // document-level default
});
```

Mark an operation public with `@Endpoint({ security: publicEndpoint })`.

### Why there is no `@CurrentUser()`

Handlers are static class properties invoked with itty's positional `(req, ...args)`, not through a DI-constructed call. With `emitDecoratorMetadata: false` and no `AsyncLocalStorage`, a parameter decorator has nothing to hook into — implementing one would need a module-level "current request", which is unsound the moment two requests are in flight. Read `req.principal`, or `getPrincipal(req)` where the static type is not narrowed.

## GraphQL

```ts
import { buildSemanticSchema, createGraphQLHandler } from '@di-framework/graphql';
import { Authenticated, Authorize, createAuthContext, protectSchema, requireSubject } from '@di-framework/auth/graphql';

@Portal()
class Library {
  @Field(() => Book)
  catalogue(): Book[] { return books; }        // public

  @Authenticated()
  @Authorize({ resource: 'loan', action: 'create' })
  @Action(() => Loan)
  borrow(@Arg('id') id: string, @Ctx() ctx: AuthGraphQLContext): Loan {
    return lend(id, requireSubject(ctx));
  }
}

const api = protectSchema(buildSemanticSchema());
const handler = createGraphQLHandler(api, {
  context: createAuthContext({ strategy: auth.strategy }),
});
```

`@Authenticated({ amr: ['mfa'], maxAge: 300 })` requires a stronger or more recent authentication — still authentication, not authorization.

`@Authorize(metadata)` applies to types, fields, actions, and subscriptions. It calls the manager after any `@Authenticated()` check. Use `@Authorize(metadata, { allowAnonymous: true })` only for deliberately anonymous policies. A denial uses `errors[0].extensions.code === 'FORBIDDEN'`, while the manager's reason remains private.

`@PublicField()` is a complete public opt-out: it disables both authentication and authorization declarations for that field, including rules inherited from the containing type.

Authentication rejections surface as `errors[0].extensions.code === 'UNAUTHENTICATED'`, and the message on the wire is always the generic public text.

Note: `printSDL` renders from the type graph rather than the executable schema, so `@authenticated` does not appear in the printed SDL. The SDL describes the shape; the executable schema enforces access.

## Storage providers

```ts
import { inMemoryAuthStores } from '@di-framework/auth';
import { repoSessionStore, repoUserStore } from '@di-framework/auth/repo';

registerAuth({
  secret,
  stores: {
    users: repoUserStore({ adapter: userAdapter }),
    sessions: repoSessionStore({ adapter: sessionAdapter }),
  },
});
```

Interfaces: `UserStore`, `SessionStore`, `CredentialStore`, `StateStore`, `RefreshTokenStore`, `KeyStore`, `LoginThrottle`.

Three methods must be a compare-and-swap: `StateStore.consume`, `RefreshTokenStore.rotate`, and `CredentialStore.updateSignCount`. They are the replay defences for OAuth `state`, refresh tokens, and WebAuthn sign counters. `StorageAdapter` has no conditional write, so `repoStateStore` and `repoRefreshTokenStore` require an explicit `atomic` hook and **throw at construction without one** rather than shipping a defence that silently does nothing.

## Security notes

**Choosing a password hasher.** The default is PBKDF2-HMAC-SHA-256 at 600,000 iterations (NIST SP 800-132; OWASP's 2024 figure), because it is the only password KDF the Web Cryptography API offers and this package carries no dependencies. PBKDF2 is memory-cheap, so a GPU attacker gets better value against it than against Argon2id. If you run on Bun or Node, supply a stronger hasher:

```ts
registerAuth({ secret, hasher: bunPasswordHasher() });   // Argon2id via Bun.password
```

Stored hashes record their own parameters, and `login` re-hashes transparently when they are below the current setting — so upgrading is a one-line change with no migration.

**Login throttling is on by default** and is not optional in spirit: SP 800-63B §5.2.2 requires it, and PBKDF2 at 600,000 iterations is expensive enough to be a denial-of-service vector without it. The in-memory throttle is per-process; use a shared one behind a load balancer.

**Cookies.** Defaults are `__Host-` prefixed: `Secure`, `HttpOnly`, `Path=/`, no `Domain`, `SameSite=Lax`. Setting a `Domain` downgrades the name to `__Secure-` and warns, because browsers reject a `__Host-` cookie carrying a `Domain` outright. A `__Secure-` cookie is writable by every subdomain, so if you need cross-subdomain SSO, pair it with strict CSRF checking.

**Cloudflare Workers.** Session and bearer verification are cheap and run fine at the edge. PBKDF2 at 600,000 iterations may exceed the Workers CPU limit — verify passwords at your origin.

**Timing.** Login reports the same error and burns the same work whether the user is missing, has no password, or typed the wrong one.

## API Reference

| Export | Description |
| --- | --- |
| `registerAuth(options)` | Build and register the runtime with the DI container. |
| `Auth(options)` | Class-decorator sugar over `registerAuth`. |
| `chain(strategies)` | Compose strategies, first match wins. |
| `sessionCookieStrategy` / `bearerTokenStrategy` / `apiKeyStrategy` | Built-in strategies. |
| `sessionManager(options)` | Session issuance, resolution, regeneration, revocation. |
| `passwordService(options)` | NIST-compliant password policy, login, and rehashing. |
| `csrfGuard(options)` | Session-bound signed double-submit tokens. |
| `signJwt` / `verifyJwt` / `signJws` / `verifyJws` | Token primitives with a required algorithm allowlist. |
| `keyService(options)` / `remoteJwks(uri)` | Key rotation and JWKS publishing/consumption. |
| `refreshService(options)` | Rotation with reuse detection. |
| `webAuthnService(options)` | `@di-framework/auth/webauthn` — the two ceremonies. |
| `oauthClient(provider, deps)` | `@di-framework/auth/oauth` — the relying party. |
| `inMemoryAuthStores()` | Development and test storage. |
| `repo*Store(options)` | `@di-framework/auth/repo` — `StorageAdapter` bridge. |
| `withAuthRoutes` / `protect` / `requireAuth` | `@di-framework/auth/http` — guards. |
| `AuthorizationManager` / `AUTHORIZATION_MANAGER` | Application-owned policy decision point and its DI token. |
| `requireAuthz` / `authorize` | `@di-framework/auth/http` — authorization guards. |
| `createAuthRoutes(options)` | `@di-framework/auth/http` — mountable protocol endpoints. |
| `protectSchema` / `Authenticated` / `Authorize` / `createAuthContext` | `@di-framework/auth/graphql`. |

## Non-goals (v1)

1. **An authorization policy model.** The package supplies the `AuthorizationManager` extension point and transport plumbing. Applications and remote policy agents may define their own vocabulary, or opt into the separate [`@di-framework/authz`](authorization.md) companion.
2. **Full WebAuthn attestation verification.** `none` and self-attested `packed` are verified; anything else needs FIDO Metadata Service integration. The extension point is `WebAuthnConfig.verifyAttestation`. Known gap: `fido-u2f`, which older security keys still emit.
3. **Being an authorization server.** This is a relying party — no `/authorize`, no `/token`, no consent screen, no client registration.
4. **Multi-factor orchestration** (TOTP, SMS, magic links, step-up state machines). `amr` and `acr` are recorded so you can build it.
5. **Redis, KV, and SQL stores.** Interfaces, in-memory implementations, and the `StorageAdapter` bridge only.
6. **Account recovery and email delivery.** Tokens are provided; sending them is yours.
7. **An `@authenticated` directive in the printed SDL.**
8. SAML, LDAP, Kerberos, and multi-tenant modelling.

## Example

https://github.com/di-framework/di-framework/tree/main/examples/packages/auth
