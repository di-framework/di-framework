/**
 * Ambient declaration for the WIT import that only exists inside a composed
 * WebAssembly component. Mirrors `di-framework:pglite@0.2.0` in
 * `di-framework/platform` (`platform/pglite-component/wit/world.wit`).
 */
declare module 'di-framework:pglite/database@0.2.0' {
  export type Value =
    | { tag: 'null'; val?: undefined }
    | { tag: 'integer'; val: bigint }
    | { tag: 'real'; val: number }
    | { tag: 'text'; val: string }
    | { tag: 'blob'; val: Uint8Array }
    | { tag: 'boolean'; val: boolean }
    | { tag: 'json'; val: string }
    | { tag: 'timestamp'; val: string };
  export type Row = Array<[string, Value]>;
  export type Params = Value[];
  export interface PgError {
    code: string;
    message: string;
  }
  export interface OpenOptions {
    database?: string;
    statementTimeoutMs?: number;
  }

  export class Connection {
    exec(sql: string): void;
    run(sql: string, params: Params): bigint;
    query(sql: string, params: Params): Row[];
    first(sql: string, params: Params): Row | undefined;
    begin(): void;
    commit(): void;
    rollback(): void;
    savepoint(name: string): void;
    releaseSavepoint(name: string): void;
    rollbackToSavepoint(name: string): void;
    inTransaction(): boolean;
    rowsAffected(): bigint;
    close(): void;
  }

  export function open(path: string, options?: OpenOptions): Connection;
  export function serverVersion(): string;
}
