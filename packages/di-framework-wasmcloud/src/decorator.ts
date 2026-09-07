import {
  defineBindingMetadata,
  isWitIdentifier,
  rejectsPlaintextSecret,
  type WasmCloudBindingOptions,
} from './metadata.js';

export type { WasmCloudBindingOptions };

/**
 * Declares a named wasmCloud host-interface binding on a concrete class.
 * Class identity is the DI token; `name` is the WIT import and hostInterfaces name.
 */
export function WasmCloudBinding(name: string, options: WasmCloudBindingOptions = {}) {
  // biome-ignore lint/suspicious/noExplicitAny: class decorator constructor
  return <T extends { new (...args: any[]): object }>(ctor: T): T => {
    if (!isWitIdentifier(name)) {
      throw new Error(
        `WasmCloud binding name "${name}" must be a WIT identifier matching /^[a-z][a-z0-9-]*$/`,
      );
    }
    const secretProblem = rejectsPlaintextSecret(options.config);
    if (secretProblem !== undefined) {
      throw new Error(`WasmCloud binding "${name}": ${secretProblem}`);
    }
    defineBindingMetadata(ctor, { name, options });
    return ctor;
  };
}
