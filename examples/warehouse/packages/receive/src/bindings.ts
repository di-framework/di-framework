import { Container } from '@di-framework/core/decorators';
import { KeyValue, WasmCloudBinding } from '@di-framework/wasmcloud';

@WasmCloudBinding('stock', { configFrom: 'di-tenant-stock' })
@Container()
export class Stock extends KeyValue {}

export type Bucket = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
};

type NativeBucket = {
  get(key: string): Promise<unknown>;
  set(key: string, value: Uint8Array, options: undefined): Promise<unknown>;
};

// Component runtimes may expose WIT results directly or as tagged values.
function unwrap<T>(value: unknown): T {
  if (value !== null && typeof value === 'object' && 'tag' in value) {
    const result = value as { tag: string; val?: unknown };
    if (result.tag === 'err')
      throw new Error(`Stock operation failed: ${JSON.stringify(result.val)}`);
    if (result.tag === 'ok') return result.val as T;
  }
  return value as T;
}

export async function pallets(): Promise<Bucket> {
  const bucket = unwrap<NativeBucket>(await new Stock().open('pallets'));
  return {
    async get(key) {
      const value = unwrap<Uint8Array | undefined>(await bucket.get(key));
      return value == null ? null : new TextDecoder().decode(value);
    },
    async set(key, value) {
      unwrap(await bucket.set(key, new TextEncoder().encode(value), undefined));
    },
  };
}
