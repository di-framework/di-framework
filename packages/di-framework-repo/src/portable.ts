/**
 * Portable entry selected by the `wasmcloud` export condition. It exposes the
 * full repository/migration surface but registers only the Wasm SQLite opener,
 * so bundles never reference `bun:sqlite` or `node:sqlite`.
 */
export * from './adapter';
export * from './adapters/bun-sqlite';
export * from './adapters/d1';
export * from './adapters/sql';
export * from './blob/index';
export * from './decorators';
export * from './in-memory';
export * from './migrations/index';
export * from './query-derivation';
export * from './repository';
export * from './sqlite/index';
export * from './types';
