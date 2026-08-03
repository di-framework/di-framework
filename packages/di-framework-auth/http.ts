/**
 * `@di-framework/http` integration.
 *
 * A subpath export so `itty-router` stays a genuinely optional peer: were these
 * re-exported from the root barrel, a consumer doing only GraphQL or only bearer
 * verification in a queue worker would fail at import time.
 */
export * from './src/http/index.ts';
