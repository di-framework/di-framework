/**
 * Ambient declaration for the WIT import that only exists inside a composed
 * WebAssembly component. Mirrors `di-framework:sqlite@0.1.0` in
 * `@di-framework/cli-plugin-wasmcloud/assets/wit/deps/di-framework-sqlite`.
 */
declare module 'di-framework:sqlite/database@0.1.0' {
  export type SqlValue =
    | { tag: 'null'; val?: undefined }
    | { tag: 'integer'; val: bigint }
    | { tag: 'real'; val: number }
    | { tag: 'text'; val: string }
    | { tag: 'blob'; val: Uint8Array };
  export type Row = Array<[string, SqlValue]>;
  export type Params = SqlValue[];
  export interface OpenOptions {
    create?: boolean;
    readOnly?: boolean;
    synchronous?: 'off' | 'normal' | 'full';
    journalMode?: 'delete' | 'persist' | 'memory';
    busyTimeoutMs?: number;
    foreignKeys?: boolean;
  }

  export class Connection {
    run(sql: string, params: Params): bigint;
    query(sql: string, params: Params): Row[];
    first(sql: string, params: Params): Row | undefined;
    exec(sql: string): void;
    close(): void;
  }

  export function open(path: string, options?: OpenOptions): Connection;
}
