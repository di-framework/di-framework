type BuilderMethods<T> = {
  [K in keyof T]-?: (value: T[K]) => BuilderMethods<T> & { build(): T };
};

/**
 * Attaches a static `builder()` factory to a class, exposing a fluent setter
 * for every own property of a default-constructed instance.
 *
 * @example
 * @Builder
 * class Config {
 *   host = '';
 *   port = 0;
 * }
 *
 * const cfg = (Config as any).builder().host('localhost').port(8080).build();
 */
export function Builder<T extends { new (...args: any[]): {} }>(target: T) {
  // Create a builder class dynamically
  class DynamicBuilder {
    private data: Partial<InstanceType<T>> = {};

    constructor() {
      // Automatically create fluent setters for every property
      const keys = Object.getOwnPropertyNames(new target()) as (keyof InstanceType<T>)[];

      for (const key of keys) {
        if (typeof key === 'string' && key !== 'constructor') {
          (this as any)[key] = (value: any) => {
            (this.data as any)[key] = value;
            return this;
          };
        }
      }
    }

    build(): InstanceType<T> {
      // Create a new instance and assign the collected values
      const instance = new target();
      Object.assign(instance, this.data);
      return instance as InstanceType<T>;
    }
  }

  // Attach a static builder() method to the original class
  (target as any).builder = () =>
    new DynamicBuilder() as unknown as BuilderMethods<InstanceType<T>>;

  return target;
}
