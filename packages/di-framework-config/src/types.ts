/**
 * Loads a flat or nested configuration object from a backing store.
 */
export interface ConfigSource {
  /** Optional label used in error messages. */
  name?: string;
  load(): Record<string, unknown> | Promise<Record<string, unknown>>;
}

/**
 * Validates / transforms a merged config object into a typed result.
 * Adapters (e.g. Zod) implement this interface.
 */
export interface ConfigSchema<T = unknown> {
  parse(input: unknown): T;
}

export type ConfigKeyCase = 'camel' | 'lower' | 'preserve';

export interface LoadConfigOptions<T = Record<string, unknown>> {
  /** Sources are deep-merged left → right (later wins). */
  sources?: ConfigSource[];
  /** Base values applied before sources. */
  defaults?: Record<string, unknown>;
  /** Optional schema; when set, return type is `T`. */
  schema?: ConfigSchema<T>;
}

export interface ConfigContainer {
  registerFactory?<T>(name: string, factory: () => T, options?: { singleton?: boolean }): unknown;
  resolve?<T>(token: string | (abstract new (...args: never[]) => T)): T;
  has?(token: string | (abstract new (...args: never[]) => unknown)): boolean;
}

export interface RegisterConfigOptions {
  /** DI token for the root config object. Defaults to `'config'`. */
  token?: string;
  /**
   * Also register dotted paths as factories (`config.db.host` → token `'config.db.host'`).
   * Defaults to `true`.
   */
  flatten?: boolean;
  container?: unknown;
}

export interface ConfigurationDecoratorOptions<T = Record<string, unknown>>
  extends LoadConfigOptions<T>,
    RegisterConfigOptions {
  /**
   * When true (default), also register the decorated class as a singleton
   * whose instance is `Object.assign(new Ctor(), loaded)`.
   */
  registerClass?: boolean;
  singleton?: boolean;
}

export interface ValueDecoratorOptions {
  /** Root config token. Defaults to `'config'`. */
  token?: string;
}
