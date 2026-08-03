import type { AuthResult } from './result.ts';

/**
 * The authentication provider interface.
 *
 * A strategy answers one question: does this request carry a credential of my
 * kind, and is it valid? It does not decide what the caller may then do — that
 * is authorization, which lives in your domain code.
 *
 * Strategies are factory functions returning object literals, matching the
 * convention set by `EventTransport` in `@di-framework/events` and
 * `ConfigSource` in `@di-framework/config`. A custom one is about ten lines:
 *
 * ```ts
 * export function headerStrategy(users: UserStore): AuthStrategy {
 *   return {
 *     name: 'x-user',
 *     async authenticate({ request }) {
 *       const id = request.headers.get('x-user-id');
 *       if (!id) return noCredential();
 *       const user = await users.findById(id);
 *       if (!user) return authFailed('invalid_credentials', `No user '${id}'`);
 *       return authenticated(createPrincipal({ sub: user.id, method: 'api-key' }));
 *     },
 *   };
 * }
 * ```
 */
export interface AuthStrategy {
  /** Stable name, used in diagnostics and to map onto OpenAPI security schemes. */
  readonly name: string;
  authenticate(context: AuthRequestContext): Promise<AuthResult>;
  /** `WWW-Authenticate` value offered when no strategy matched. */
  challenge?(context: AuthRequestContext): string | undefined;
}

export interface AuthRequestContext {
  readonly request: Request;
  /** Parsed `Cookie` header, computed once and shared across the chain. */
  readonly cookies: Readonly<Record<string, string>>;
  readonly url: URL;
  readonly method: string;
}

/**
 * The container surface this package needs.
 *
 * Structural rather than the concrete `Container` class, so the auth package
 * never couples to a specific version of core — the same approach
 * `@di-framework/config` takes with `ConfigContainer`.
 */
export interface AuthContainer {
  registerFactory?<T>(name: string, factory: () => T, options?: { singleton?: boolean }): unknown;
  resolve?<T>(token: string | (abstract new (...args: never[]) => T)): T;
  has?(token: string | (abstract new (...args: never[]) => unknown)): boolean;
  emit?(event: string, payload: unknown): void;
}
