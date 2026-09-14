import { Container } from '@di-framework/core/decorators';
import { KeyValue, Messaging, WasmCloudBinding } from '@di-framework/wasmcloud';

@WasmCloudBinding('stock')
@Container()
export class Stock extends KeyValue {}

@WasmCloudBinding('sync')
@Container()
export class Sync extends Messaging {}

export type Bucket = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
};

export async function pallets(): Promise<Bucket> {
  return (await new Stock().open('pallets')) as Bucket;
}
