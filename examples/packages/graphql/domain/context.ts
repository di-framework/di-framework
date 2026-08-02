/**
 * The per-request context every resolver sees.
 *
 * `@di-framework/graphql` threads whatever the transport builds (see
 * `server.ts`) through to any parameter decorated with `@Ctx()` — or to any
 * undecorated parameter conventionally named `ctx` / `context`.
 */

import type { GraphQLContext } from '@di-framework/graphql';

export interface LibraryContext extends GraphQLContext {
  /** The signed-in member, if any. */
  memberId?: string;
  roles?: string[];
}

/** Authorization lives in the domain, not in a resolver map. */
export function requireMember(ctx: LibraryContext): string {
  if (!ctx.memberId) throw new Error('Not authenticated: no member on this request.');
  return ctx.memberId;
}

export function requireLibrarian(ctx: LibraryContext): string {
  const memberId = requireMember(ctx);
  if (!ctx.roles?.includes('librarian')) {
    throw new Error(`Member ${memberId} is not a librarian.`);
  }
  return memberId;
}
