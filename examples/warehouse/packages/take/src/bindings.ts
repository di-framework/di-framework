import { Container } from '@di-framework/core/decorators';
import { KeyValue, WasmCloudBinding } from '@di-framework/wasmcloud';

@WasmCloudBinding('stock')
@Container()
export class Stock extends KeyValue {}

export type Bucket = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
};

export async function pallets(): Promise<Bucket> {
  return (await new Stock().open('pallets')) as Bucket;
}
