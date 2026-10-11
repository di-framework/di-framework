/**
 * Portable entry selected by the `wasmcloud` export condition. It exposes the
 * full repository/migration surface and the wasmCloud Postgres value codec,
 * but registers only the Wasm SQLite opener, so bundles never reference
 * `bun:sqlite` or `node:sqlite`.
 */
export * from './adapter';
export * from './adapters/bun-sqlite';
export * from './adapters/d1';
export * from './adapters/sql';
export * from './blob/index';
export * from './decorators';
export * from './in-memory';
export * from './migrations/index';
export * from './postgres';
export * from './query-derivation';
export * from './repository';
// Lease lock, mutex, and Wasm value helpers for out-of-tree SqlDatabase adapters.
export * from './sql-lock';
export * from './sqlite/index';
export * from './types';
export { isWasmResult, type WasmMaybeResult, type WasmResult, wasmBlobBytes } from './wasm-values';
