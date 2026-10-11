/**
 * Stable surface for `SqlDatabase` adapter packages that live outside
 * `@di-framework/repo` (for example `@di-framework/pglite-component`). It holds
 * the dialect-neutral pieces an adapter needs: the `SqlDatabase` contract and
 * brand, the connection mutex, the transaction/savepoint lease lock, the
 * `result<T, E>` shapes Wasm bindings return, and the blob value helper.
 *
 * Import it as `@di-framework/repo/adapter-kit`. It never references
 * `bun:sqlite` or `node:sqlite`, so it is safe in Wasm component bundles.
 */
export {
  contextLock,
  type Guard,
  guardedStatements,
  type Lease,
  leaseGuard,
  type SqlStatementCalls,
} from './sql-lock';
export {
  AsyncMutex,
  SQL_DATABASE_BRAND,
  type SqlDatabase,
  type SqlRow,
} from './sqlite/sql-database';
export type { WasmMaybeResult, WasmResult } from './sqlite/wasm';
export { wasmBlobBytes } from './wasm-values';
