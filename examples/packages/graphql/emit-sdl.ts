/**
 * Emit the schema as a build artifact: `bun run sdl`.
 *
 * `printSDL` lives in `@di-framework/graphql/core`, which does not import
 * `graphql` at all — so schema emission and architecture assertions stay cheap
 * enough to run in CI on every commit, and the printed SDL is diffable in
 * review the way an OpenAPI document is.
 */

import { printSDL } from '@di-framework/graphql/core';
import { library, publicCatalog } from './schema.ts';

const annotated = printSDL(library.graph, { directives: true });
const portable = printSDL(publicCatalog.graph, { directives: false, descriptions: false });

await Bun.write(new URL('./schema.graphql', import.meta.url), annotated);
await Bun.write(new URL('./schema.public.graphql', import.meta.url), portable);

console.log(`schema.graphql          ${library.contexts.join(', ')} (${annotated.length} bytes)`);
console.log(
  `schema.public.graphql   ${publicCatalog.contexts.join(', ')} (${portable.length} bytes)`,
);
