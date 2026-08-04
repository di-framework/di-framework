/**
 * Everything that does not need `graphql` installed: decorators, the registry,
 * the semantic type graph and the SDL printer.
 *
 * Import from here when you only want to emit or assert on the schema (build
 * scripts, architecture tests), and from the package root when you want to
 * execute queries.
 */

export {
  type AuthDenial,
  type AuthorizationOptions,
  type AuthRequirement,
  type AuthRequirementContext,
  denialToError,
  evaluateRequirements,
  SemanticAuthorizationError,
} from './src/authorization.ts';
export {
  type Connection,
  type ConnectionArgs,
  connectionFromArray,
  connectionFromSlice,
  cursorToOffset,
  decodeCursor,
  type Edge,
  encodeCursor,
  isConnection,
  offsetToCursor,
  type PageInfo,
  toConnection,
} from './src/connection.ts';
export * from './src/decorators.ts';
export * from './src/errors.ts';
export { type BatchFunction, BatchLoader } from './src/loader.ts';
export {
  collectFieldDeclarations,
  getBoundedContext,
  getLookup,
} from './src/metadata.ts';
export { getRegistry, SemanticRegistry, setRegistry } from './src/registry.ts';
export * from './src/scalars.ts';
export { type PrintOptions, printSDL, printTypeNode } from './src/sdl.ts';
export { buildTypeGraph, namedTypeNode } from './src/type-graph.ts';
export type * from './src/types.ts';
export { UnionRef } from './src/types.ts';
