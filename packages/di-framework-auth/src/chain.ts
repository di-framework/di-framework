import { AuthError } from './errors.ts';
import type { Principal } from './principal.ts';
import { type AuthResult, authFailed, noCredential } from './result.ts';
import type { AuthRequestContext, AuthStrategy } from './types.ts';

/**
 * Compose several strategies into one.
 *
 * First match wins, in the order given. The three-state {@link AuthResult} is
 * what makes this safe:
 *
 * - `no-credential` → this strategy saw nothing of its kind; try the next one.
 * - `failed` → a credential of this kind *was* present and was bad; **stop**.
 * - `authenticated` → done.
 *
 * Continuing past a failure would mean a request carrying a forged bearer token
 * falls through to the next strategy and, finding no cookie either, ends up
 * treated as anonymous — turning a rejected credential into a silently
 * downgraded one.
 */

export interface ChainOptions {
  /** Names a strategy that must not be skipped even if it returns no credential. */
  required?: readonly string[];
}

export function chain(
  strategies: readonly AuthStrategy[],
  options: ChainOptions = {},
): AuthStrategy {
  if (strategies.length === 0) {
    throw new Error('chain() requires at least one strategy');
  }
  const required = new Set(options.required ?? []);

  return {
    name: strategies.map((strategy) => strategy.name).join('+'),

    async authenticate(context): Promise<AuthResult> {
      for (const strategy of strategies) {
        const result = await strategy.authenticate(context);
        if (result.state === 'authenticated') return result;
        if (result.state === 'failed') return result;
        if (required.has(strategy.name)) {
          return authFailed(
            'no_credential',
            `Required strategy '${strategy.name}' found no credential`,
          );
        }
      }
      return noCredential();
    },

    challenge(context) {
      return challengesOf(strategies, context)[0];
    },
  };
}

/** Every challenge the strategies can offer, for a multi-header 401. */
export function challengesOf(
  strategies: readonly AuthStrategy[],
  context: AuthRequestContext,
): string[] {
  const out: string[] = [];
  for (const strategy of strategies) {
    const challenge = strategy.challenge?.(context);
    if (challenge && !out.includes(challenge)) out.push(challenge);
  }
  return out;
}

/**
 * Run a strategy and return the principal, or `undefined` when there was no
 * credential. A *failed* credential still throws — see the note above.
 */
export async function authenticate(
  strategy: AuthStrategy,
  context: AuthRequestContext,
): Promise<Principal | undefined> {
  const result = await strategy.authenticate(context);
  if (result.state === 'authenticated') return result.principal;
  if (result.state === 'failed') throw AuthError.fromFailure(result);
  return undefined;
}

/** Run a strategy and require a principal. Throws `AuthError` otherwise. */
export async function requireAuthentication(
  strategy: AuthStrategy,
  context: AuthRequestContext,
  challenges: readonly string[] = [],
): Promise<Principal> {
  const result = await strategy.authenticate(context);
  if (result.state === 'authenticated') return result.principal;
  if (result.state === 'failed') throw AuthError.fromFailure(result, challenges);
  throw new AuthError('No credential presented', {
    code: 'no_credential',
    challenges:
      challenges.length > 0
        ? challenges
        : strategy.challenge?.(context)
          ? [strategy.challenge(context)!]
          : [],
  });
}
