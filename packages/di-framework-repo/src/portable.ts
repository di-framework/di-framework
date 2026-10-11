/**
 * Portable entry selected by the `wasmcloud` export condition. It exposes the
 * full repository/migration surface, the wasmCloud Postgres value codec, and
 * the PGlite (`di-framework:pglite`) adapter, but registers only the Wasm
 * SQLite opener, so bundles never reference `bun:sqlite` or `node:sqlite`.
 */
export * from './adapter';
export * from './adapters/bun-sqlite';
export * from './adapters/d1';
export * from './adapters/sql';
export * from './blob/index';
export * from './decorators';
export * from './in-memory';
export * from './migrations/index';
export * from './pglite/index';
export * from './postgres';
export * from './query-derivation';
export * from './repository';
export * from './sqlite/index';
export * from './types';
