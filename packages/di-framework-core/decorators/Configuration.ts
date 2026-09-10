import { defineMetadata, getMetadata } from '../container.js';

export type BeanToken<T = unknown> = string | (new (...args: any[]) => T);

export interface BeanOptions {
  /** Tokens supplied to the factory method, in argument order. */
  dependencies?: readonly BeanToken[];
}

export interface BeanDefinition {
  token: BeanToken;
  methodName: string | symbol;
  dependencies: readonly BeanToken[];
}

const CONFIGURATION_KEY = 'di:configuration';
const BEANS_KEY = 'di:configuration:beans';

/** Marks a class as an explicit source of application bean factories. */
export function Configuration() {
  return <T extends new (...args: any[]) => object>(ctor: T) => {
    defineMetadata(CONFIGURATION_KEY, true, ctor);
    return ctor;
  };
}

/**
 * Declares a configuration method as a bean factory. When no token is given,
 * the method name is used. Dependencies are deliberately explicit and never
 * inferred from emitted decorator metadata.
 */
export function Bean(token?: BeanToken, options?: BeanOptions): MethodDecorator;
export function Bean(options?: BeanOptions): MethodDecorator;
export function Bean(
  tokenOrOptions?: BeanToken | BeanOptions,
  maybeOptions: BeanOptions = {},
): MethodDecorator {
  return (target, propertyKey, descriptor) => {
    if (typeof descriptor.value !== 'function') {
      throw new TypeError(`@Bean can only decorate methods (${String(propertyKey)})`);
    }
    const token =
      typeof tokenOrOptions === 'string' || typeof tokenOrOptions === 'function'
        ? tokenOrOptions
        : String(propertyKey);
    const options =
      typeof tokenOrOptions === 'object' && tokenOrOptions !== null ? tokenOrOptions : maybeOptions;
    const ctor = target.constructor;
    const current = (getMetadata(BEANS_KEY, ctor) as BeanDefinition[] | undefined) ?? [];
    defineMetadata(
      BEANS_KEY,
      [
        ...current,
        { token, methodName: propertyKey, dependencies: [...(options.dependencies ?? [])] },
      ],
      ctor,
    );
  };
}

export function getBeanDefinitions(target: Function): readonly BeanDefinition[] {
  if (getMetadata(CONFIGURATION_KEY, target) !== true) {
    throw new Error(`Configuration class '${target.name}' must be decorated with @Configuration()`);
  }
  return (getMetadata(BEANS_KEY, target) as BeanDefinition[] | undefined) ?? [];
}
