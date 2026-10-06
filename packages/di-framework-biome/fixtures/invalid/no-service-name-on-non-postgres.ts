declare class KeyValue {}

@WasmCloudBinding('cache', { serviceName: 'cache' })
export class Cache extends KeyValue {
  open() {
    return 'bucket';
  }
}
