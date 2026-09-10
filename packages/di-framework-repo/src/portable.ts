/**
 * Portable entry selected by the `wasmcloud` export condition. It exposes the
 * full repository/migration surface but registers only the Wasm SQLite opener,
 * so bundles never reference `bun:sqlite` or `node:sqlite`.
 */
export * from './adapter.js';
export * from './adapters/bun-sqlite.js';
export * from './adapters/d1.js';
export * from './adapters/sql.js';
export * from './blob/index.js';
export * from './decorators.js';
export * from './in-memory.js';
export * from './migrations/index.js';
export * from './query-derivation.js';
export * from './repository.js';
export * from './sqlite/index.js';
export * from './types.js';
