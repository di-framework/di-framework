import { Container } from './container.js';
import {
  type BeanDefinition,
  type BeanToken,
  getBeanDefinitions,
} from './decorators/Configuration.js';

type ConfigurationSource = object | (new (...args: any[]) => object);
type BootstrapToken = string | (new (...args: any[]) => any);
type ContextState = 'new' | 'starting' | 'started' | 'stopping' | 'stopped' | 'failed';

function label(token: BeanToken): string {
  return typeof token === 'string' ? token : token.name;
}

/** Explicit application startup and lifecycle coordinator. */
export class ApplicationContext {
  readonly container: Container;
  private readonly configurations: ConfigurationSource[] = [];
  private readonly bootstraps: BootstrapToken[] = [];
  private readonly startedComponents: any[] = [];
  private state: ContextState = 'new';
  private startPromise?: Promise<this>;
  private stopPromise?: Promise<this>;
  private failure?: unknown;

  constructor(container = new Container()) {
    this.container = container;
  }

  static builder(container?: Container): ApplicationContext {
    return new ApplicationContext(container);
  }

  configuration(...sources: ConfigurationSource[]): this {
    this.assertMutable();
    this.configurations.push(...sources);
    return this;
  }

  bootstrap(...tokens: BootstrapToken[]): this {
    this.assertMutable();
    this.bootstraps.push(...tokens);
    return this;
  }

  start(): Promise<this> {
    if (this.state === 'started') return Promise.resolve(this);
    if (this.state === 'starting' && this.startPromise) return this.startPromise;
    if (this.state === 'failed') return Promise.reject(this.failure);
    if (this.state !== 'new') {
      return Promise.reject(new Error(`ApplicationContext cannot start after it is ${this.state}`));
    }
    this.state = 'starting';
    this.startPromise = this.performStart();
    return this.startPromise;
  }

  stop(): Promise<this> {
    if (this.state === 'stopped') return Promise.resolve(this);
    if (this.state === 'stopping' && this.stopPromise) return this.stopPromise;
    this.stopPromise = this.performStop();
    return this.stopPromise;
  }

  private async performStart(): Promise<this> {
    try {
      const factories = this.preflight();
      for (const factory of factories) {
        const args = factory.definition.dependencies.map((dependency) =>
          this.container.resolve(dependency),
        );
        const value = await (factory.instance as any)[factory.definition.methodName](...args);
        this.container.registerValue(factory.definition.token, value);
      }

      for (const token of this.bootstraps) {
        if (typeof token !== 'string' && !this.container.has(token)) this.container.register(token);
        const component = this.container.resolve<any>(token);
        if (typeof component?.start === 'function') await component.start();
        this.startedComponents.push(component);
      }
      this.state = 'started';
      return this;
    } catch (error) {
      this.failure = error;
      await this.cleanup();
      this.state = 'failed';
      throw error;
    }
  }

  private async performStop(): Promise<this> {
    if (this.state === 'starting' && this.startPromise) {
      try {
        await this.startPromise;
      } catch {
        return this;
      }
    }
    if (this.state === 'new') {
      this.state = 'stopped';
      return this;
    }
    if (this.state === 'failed') return this;
    this.state = 'stopping';
    await this.cleanup();
    this.container.stopCronJobs();
    this.state = 'stopped';
    return this;
  }

  private async cleanup(): Promise<void> {
    let firstError: unknown;
    while (this.startedComponents.length > 0) {
      const component = this.startedComponents.pop();
      try {
        if (typeof component?.stop === 'function') await component.stop();
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError && this.state !== 'starting') throw firstError;
  }

  private preflight(): Array<{ definition: BeanDefinition; instance: object }> {
    const factories: Array<{ definition: BeanDefinition; instance: object }> = [];
    const definitions = new Map<BeanToken, BeanDefinition>();
    for (const source of this.configurations) {
      const ctor = (typeof source === 'function' ? source : source.constructor) as new (
        ...args: any[]
      ) => object;
      const instance = typeof source === 'function' ? this.container.construct(ctor) : source;
      for (const definition of getBeanDefinitions(ctor)) {
        if (definitions.has(definition.token) || this.container.has(definition.token)) {
          throw new Error(`Duplicate bean token '${label(definition.token)}'`);
        }
        definitions.set(definition.token, definition);
        factories.push({ definition, instance });
      }
    }
    for (const definition of definitions.values()) {
      for (const dependency of definition.dependencies) {
        if (!definitions.has(dependency) && !this.container.has(dependency)) {
          throw new Error(
            `Missing dependency '${label(dependency)}' required by bean '${label(definition.token)}'`,
          );
        }
      }
    }

    const ordered: typeof factories = [];
    const visiting = new Set<BeanToken>();
    const visited = new Set<BeanToken>();
    const byToken = new Map(factories.map((factory) => [factory.definition.token, factory]));
    const visit = (token: BeanToken, path: BeanToken[]) => {
      if (visited.has(token)) return;
      if (visiting.has(token)) {
        throw new Error(`Cyclic bean dependency: ${[...path, token].map(label).join(' -> ')}`);
      }
      visiting.add(token);
      const factory = byToken.get(token);
      if (factory) {
        for (const dependency of factory.definition.dependencies) {
          if (byToken.has(dependency)) visit(dependency, [...path, token]);
        }
        ordered.push(factory);
      }
      visiting.delete(token);
      visited.add(token);
    };
    for (const token of byToken.keys()) visit(token, []);
    return ordered;
  }

  private assertMutable(): void {
    if (this.state !== 'new') throw new Error('ApplicationContext is already starting or stopped');
  }
}
