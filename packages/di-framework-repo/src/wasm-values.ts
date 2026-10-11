/**
 * Value helpers shared by the Wasm SQL adapters. `wasmBlobBytes` is exported
 * from the package entry for out-of-tree adapter packages.
 */

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
