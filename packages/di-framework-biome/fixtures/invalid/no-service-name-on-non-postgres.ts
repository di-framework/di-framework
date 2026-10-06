@WasmCloudBinding('cache', { serviceName: 'cache' })
export class Cache extends KeyValue {
  open() {
    return 'bucket';
  }
}

declare class KeyValue {}
