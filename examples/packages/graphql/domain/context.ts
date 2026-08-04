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

/**
 * Authorization lives in the domain, not in a resolver map.
 *
 * Declarative requirements are expressed with `@Requires` on the field or
 * action itself (see `addBook` in `catalog.ts`); `schema.ts` teaches it how to
 * read the member and roles off this context. This helper remains for the rare
 * check that has to run inside a method body.
 */
export function requireMember(ctx: LibraryContext): string {
  if (!ctx.memberId) throw new Error('Not authenticated: no member on this request.');
  return ctx.memberId;
}
