import { SemanticRegistry, setRegistry } from '../src/registry.ts';

/**
 * Run a block against an isolated registry so decorated classes declared inside
 * it do not leak into the rest of the suite.
 */
export function withRegistry<T>(fn: (registry: SemanticRegistry) => T): T {
  const fresh = new SemanticRegistry();
  const previous = setRegistry(fresh);
  try {
    return fn(fresh);
  } finally {
    setRegistry(previous);
  }
}
