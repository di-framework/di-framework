import { type Container as DIContainer, defineMetadata, useContainer } from '../container.js';
import { INJECTABLE_METADATA_KEY } from './keys.js';

/**
 * Eagerly resolves a class once at definition time.
 *
 * Useful for startup-only classes (e.g. HTTP controllers) whose constructors
 * register routes or side effects and should run before handling requests.
 *
 * @deprecated Use `ApplicationContext.builder().bootstrap(MyClass).start()`.
 * Definition-time eager behavior is preserved until the next major release.
 */
export function Bootstrap(options: { singleton?: boolean; container?: DIContainer } = {}) {
  return <T extends { new (...args: any[]): {} }>(ctor: T) => {
    const container = options.container ?? useContainer();

    // Allow bootstrap to be used with or without @Container().
    if (!container.has(ctor)) {
      const singleton = options.singleton ?? true;
      defineMetadata(INJECTABLE_METADATA_KEY, true, ctor);
      container.register(ctor, { singleton });
    }

    container.resolve(ctor);
    return ctor;
  };
}
