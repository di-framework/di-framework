import { useContainer } from '@di-framework/core/container';
import { Container as ContainerDecorator } from '@di-framework/core/decorators';
import type { IRequest, RequestHandler } from 'itty-router';
import registry from './registry.ts';
import {
  TypedRouter,
  type TypedRouterType,
} from './typed-router.ts';

export type ExtensionFunction<Args extends any[] = any[]> = (
  builder: HttpRouterBuilder<Args>,
  router: BuiltHttpRouter<Args>,
) => void;

export interface HttpRouterOptions<Args extends any[] = any[]> {
  prefix?: string;
  catch?: (error: any, request?: Request) => Response | Promise<Response>;
  use?: Array<RequestHandler<IRequest, Args>>;
  auth?: boolean | Record<string, unknown>;
  singleton?: boolean;
}

export interface BuiltHttpRouter<Args extends any[] = any[]> extends TypedRouterType<Args> {
  readonly router: TypedRouterType<Args>;
  readonly prefixPath?: string;
  secure?: any;
}

let globalAuthExtension: ExtensionFunction | undefined;

export class HttpRouterBuilder<Args extends any[] = any[]> {
  private _prefix?: string;
  private _catchHandler?: (error: any, request?: Request) => Response | Promise<Response>;
  private _middleware: Array<RequestHandler<IRequest, Args>> = [];
  private _extensions: Array<ExtensionFunction<Args>> = [];
  private _authOptions?: boolean | Record<string, unknown>;

  static builder<Args extends any[] = any[]>(): HttpRouterBuilder<Args> {
    return new HttpRouterBuilder<Args>();
  }

  prefix(pathPrefix: string): this {
    this._prefix = pathPrefix.endsWith('/') ? pathPrefix.slice(0, -1) : pathPrefix;
    return this;
  }

  catch(handler: (error: any, request?: Request) => Response | Promise<Response>): this {
    this._catchHandler = handler;
    return this;
  }

  use(...middleware: Array<RequestHandler<IRequest, Args>>): this {
    this._middleware.push(...middleware);
    return this;
  }

  withAuth(options: boolean | Record<string, unknown> = true): this {
    this._authOptions = options;
    return this;
  }

  extend(extension: ExtensionFunction<Args>): this {
    this._extensions.push(extension);
    return this;
  }

  build(): BuiltHttpRouter<Args> {
    const routerOpts: any = {};
    if (this._catchHandler) {
      routerOpts.catch = this._catchHandler;
    }

    const baseRouter = TypedRouter<Args>(routerOpts);
    const prefix = this._prefix;

    const methods = ['get', 'post', 'put', 'delete', 'patch', 'head', 'options'];

    const builtProxy: any = new Proxy(baseRouter, {
      get(target, prop, receiver) {
        if (prop === 'router') return baseRouter;
        if (prop === 'prefixPath') return prefix;

        if (typeof prop === 'string' && methods.includes(prop)) {
          return (path: string, controller: any, options?: any) => {
            const fullPath = prefix ? `${prefix}${path.startsWith('/') ? path : `/${path}`}` : path;
            const handler = (baseRouter as any)[prop](fullPath, controller, options);
            return handler;
          };
        }

        const val = Reflect.get(target, prop, receiver);
        if (typeof val === 'function') {
          return val.bind(target);
        }
        return val;
      },
    });

    for (const mw of this._middleware) {
      baseRouter.all('*', mw as any);
    }

    if (this._authOptions && globalAuthExtension) {
      globalAuthExtension(this, builtProxy);
    }

    for (const ext of this._extensions) {
      ext(this, builtProxy);
    }

    return builtProxy as BuiltHttpRouter<Args>;
  }
}

export function HttpRouterFunction(options: HttpRouterOptions = {}) {
  const containerDecorator = ContainerDecorator({ singleton: options.singleton ?? true });

  return (target: any) => {
    target.isHttpRouter = true;
    target.isController = true;
    registry.addTarget(target);

    const builder = HttpRouter.builder();
    if (options.prefix) builder.prefix(options.prefix);
    if (options.catch) builder.catch(options.catch);
    if (options.use) builder.use(...options.use);
    if (options.auth) builder.withAuth(options.auth);

    const built = builder.build();
    target.httpRouter = built;
    target[Symbol.for('@di-framework/http:router')] = built;

    containerDecorator(target);

    try {
      const container: any = useContainer();
      if (container) {
        if (typeof container.registerFactory === 'function') {
          container.registerFactory('HTTP_ROUTER', () => built);
          container.registerFactory(target, () => built);
        }
      }
    } catch {
      // Container not initialized yet during module evaluation
    }
  };
}

export const HttpRouter = Object.assign(HttpRouterFunction, {
  builder<Args extends any[] = any[]>(): HttpRouterBuilder<Args> {
    return HttpRouterBuilder.builder<Args>();
  },
  registerAuthExtension(extension: ExtensionFunction): void {
    globalAuthExtension = extension;
  },
  getRouter(target: any): BuiltHttpRouter | undefined {
    return target?.httpRouter ?? (target as any)?.[Symbol.for('@di-framework/http:router')];
  },
});
