/**
 * Value helpers shared by the Wasm SQL adapters. `wasmBlobBytes` is exported
 * from the package entry for out-of-tree adapter packages.
 */

/** A WIT `result<T, E>` as a record. The `err` payload is engine-specific. */
export type WasmResult<T> = { tag: 'ok'; val: T } | { tag: 'err'; val: unknown };

/** Either a bare value (bindings that throw on `err`) or a result record. */
export type WasmMaybeResult<T> = T | WasmResult<T> | Promise<T | WasmResult<T>>;

/** Whether `value` is a `{ tag: 'ok' | 'err', val }` result record. */
export function isWasmResult<T>(value: unknown): value is WasmResult<T> {
  if (typeof value !== 'object' || value === null) return false;
  const tag = (value as { tag?: unknown }).tag;
  return (tag === 'ok' || tag === 'err') && 'val' in value;
}

/**
 * The bytes of a `Uint8Array`, `ArrayBuffer`, or other `ArrayBuffer` view, or
 * `undefined` for any other value. Views share the underlying buffer.
 */
export function wasmBlobBytes(value: unknown): Uint8Array | undefined {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return undefined;
}
