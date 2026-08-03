import { type Container as DIContainer, defineMetadata, useContainer } from '../container';
import { INJECTABLE_METADATA_KEY } from './keys';

/**
 * Eagerly resolves a class once at definition time.
 *
 * Useful for startup-only classes (e.g. HTTP controllers) whose constructors
 * register routes or side effects and should run before handling requests.
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
