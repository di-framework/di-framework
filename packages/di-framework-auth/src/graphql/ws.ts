import { chain } from '../chain.ts';
import { makeContext } from '../context.ts';
import { AuthError } from '../errors.ts';
import { isExpired, type Principal } from '../principal.ts';
import type { AuthStrategy } from '../types.ts';
import type { AuthGraphQLContext } from './context.ts';

/**
 * Authentication for `graphql-transport-ws` subscriptions.
 *
 * A WebSocket carries no `Authorization` header after the upgrade, so the
 * protocol's `connection_init` payload is where the credential arrives. This
 * rebuilds a synthetic `Request` from that payload so the very same strategies
 * that guard HTTP also guard the socket — one place where a credential is
 * checked, not two implementations that can drift.
 */

export interface WsAuthOptions {
  strategy: AuthStrategy | readonly AuthStrategy[];
  /** The connection must be authenticated. Default `true`. */
  require?: boolean;
  /** Origin of the synthetic request. Default `'http://localhost'`. */
  origin?: string;
}

/**
 * Turn a `connection_init` payload into a `Request` the strategies understand.
 *
 * Accepts either `{ authorization: 'Bearer …' }` or a bare `{ token }`, and
 * carries a `cookie` string through when the transport supplies one.
 */
export function requestFromConnectionParams(
  params: Record<string, unknown> | null | undefined,
  origin = 'http://localhost',
): Request {
  const headers = new Headers();
  const payload = params ?? {};

  const authorization = payload['authorization'] ?? payload['Authorization'];
  if (typeof authorization === 'string') headers.set('authorization', authorization);
  else if (typeof payload['token'] === 'string') {
    headers.set('authorization', `Bearer ${payload['token']}`);
  }

  const cookie = payload['cookie'] ?? payload['Cookie'];
  if (typeof cookie === 'string') headers.set('cookie', cookie);

  const apiKey = payload['apiKey'] ?? payload['x-api-key'];
  if (typeof apiKey === 'string') headers.set('x-api-key', apiKey);

  // A WebSocket upgrade is not CSRF-able in the way a form post is, and there is
  // no body, so GET is the honest shape here.
  return new Request(origin, { method: 'GET', headers });
}

/** Authenticate a connection at `connection_init`, producing the base context. */
export async function authenticateUpgrade(
  params: Record<string, unknown> | null | undefined,
  options: WsAuthOptions,
): Promise<AuthGraphQLContext> {
  const strategy = Array.isArray(options.strategy)
    ? chain(options.strategy as readonly AuthStrategy[])
    : (options.strategy as AuthStrategy);

  const request = requestFromConnectionParams(params, options.origin);
  const result = await strategy.authenticate(makeContext(request));

  if (result.state === 'authenticated') return { principal: result.principal };
  if (result.state === 'failed') throw AuthError.fromFailure(result);
  if (options.require !== false)
    throw AuthError.unauthenticated('WebSocket connection is not authenticated');
  return {};
}

/**
 * Re-check expiry on a long-lived socket.
 *
 * An HTTP request is short enough that a token checked at the start is still
 * valid at the end. A subscription can outlive its own access token by hours, so
 * call this from the subscription loop (or on a timer) and close the connection
 * when it throws.
 */
export function assertNotExpired(
  principal: Principal | undefined,
  now: () => number = () => Math.floor(Date.now() / 1000),
): void {
  if (!principal) throw AuthError.unauthenticated();
  if (isExpired(principal, now())) {
    throw new AuthError(`Credential expired at ${principal.expiresAt}`, { code: 'token_expired' });
  }
}
