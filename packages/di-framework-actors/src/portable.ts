/**
 * @di-framework/actors — portable entry point.
 *
 * Selected via the `wasmcloud` export condition (or imported explicitly as
 * `@di-framework/actors/portable`). It exposes the actor runtime, decorators,
 * in-memory storage, the distributed protocol types/dispatcher, and the Wasm-safe
 * SQLite storage adapter, and never imports `bun:sqlite` at the top level.
 *
 * `SqliteActorStorage` is aliased to `WasmSqliteActorStorage` here so generated
 * modules (`new SqliteActorStorage({ baseDir, fileLocking: false })`) work unchanged
 * inside a Wasm component.
 */

export * from './decorators/index.js';
export * from './distributed/index.js';
export * from './migrations/index.js';
export * from './runtime/index.js';
export * from './storage/memory.js';
export * from './storage/path.js';
export * from './storage/types.js';
export * from './storage/wasm-sqlite.js';
export {
  WasmSqliteActorStorage as SqliteActorStorage,
  type WasmSqliteActorStorageOptions as SqliteActorStorageOptions,
  WasmSqliteActorStorageTransaction as SqliteActorStorageTransaction,
} from './storage/wasm-sqlite.js';
export * from './types.js';
