import {
  type IRequest,
  json as ittyJson,
  type RequestHandler,
  Router,
  withContent,
} from 'itty-router';

/** Marker for body "shape + content-type" */
export type Json<T> = { readonly __kind: 'json'; readonly __type?: T };
export type Multipart<T> = {
  readonly __kind: 'multipart';
  readonly __type?: T;
};
export type PathParams<T> = { readonly __pathParams?: T };
export type QueryParams<T> = { readonly __queryParams?: T };

/** Spec types you’ll use in generics */
export type RequestSpec<BodySpec = unknown> = { readonly __req?: BodySpec };
export type ResponseSpec<Body = unknown> = { readonly __res?: Body };

/** Map a BodySpec to the actual req.content type */
type ContentOf<BodySpec> =
  BodySpec extends Json<infer T> ? T : BodySpec extends Multipart<infer _T> ? FormData : unknown;

type PathParamsOf<BodySpec> = BodySpec extends PathParams<infer T> ? T : Record<string, string>;

type QueryParamsOf<BodySpec> =
  BodySpec extends QueryParams<infer T> ? T : Record<string, string | string[] | undefined>;

/** The actual request type your handlers receive */
export type TypedRequest<ReqSpec> = Omit<IRequest, 'params' | 'query'> & {
  content: ContentOf<ReqSpec extends RequestSpec<infer B> ? B : never>;
  params: PathParamsOf<ReqSpec extends RequestSpec<infer B> ? B : never>;
  query: QueryParamsOf<ReqSpec extends RequestSpec<infer B> ? B : never>;
};

/** Typed response helper (phantom only) */
export type TypedResponse<ResSpec> = globalThis.Response & {
  readonly __typedRes?: ResSpec;
};

/** HandlerController type derived from the Request/Response specs */
export type HandlerController<ReqSpec, ResSpec, Args extends any[] = any[]> = (
  req: TypedRequest<ReqSpec>,
  ...args: Args
) => TypedResponse<ResSpec> | Promise<TypedResponse<ResSpec>>;

/** A typed json() that returns a Response annotated with Response<T> */
export function json<T>(data: T, init?: ResponseInit): TypedResponse<ResponseSpec<T>> {
  return ittyJson(data as any, init) as any;
}

export type RouteOptions = {
  multipart?: boolean;
  /**
   * Extra itty handlers run before the body parser and the controller, in order.
   *
   * itty supports any number of handlers per route; this exposes that without
   * the router needing to know what any of them mean. A handler that returns
   * anything other than `undefined` or `null` short-circuits the route, which is
   * how a guard rejects.
   *
   * These run *before* the body is parsed, so an unauthenticated POST does not
   * cause a large body to be buffered and deserialised. The visible consequence
   * is that a rejected request returns the guard's status rather than a 415
   * content-type error — authenticate first, then validate.
   */
  use?: ReadonlyArray<RequestHandler<IRequest, any[]>>;
};

export type TypedRoute<Args extends any[] = any[]> = <
  ReqSpec = RequestSpec<unknown>,
  ResSpec = ResponseSpec<unknown>,
>(
  path: string,
  controller: HandlerController<ReqSpec, ResSpec, Args>,
  options?: RouteOptions,
) => TypedRouterType<Args> & {
  path: string;
  method: string;
  reqSpec: ReqSpec;
  resSpec: ResSpec;
};

export type TypedRouterType<Args extends any[] = any[]> = {
  get: TypedRoute<Args>;
  post: TypedRoute<Args>;
  put: TypedRoute<Args>;
  delete: TypedRoute<Args>;
  patch: TypedRoute<Args>;
  head: TypedRoute<Args>;
  options: TypedRoute<Args>;
  // Add other methods as needed, or use a more generic approach
  fetch: (request: Request, ...args: Args) => Promise<Response>;
  [key: string]: any;
};

export function TypedRouter<Args extends any[] = any[]>(
  opts?: Parameters<typeof Router>[0],
): TypedRouterType<Args> {
  const r = Router(opts);

  function enforceJson(req: globalThis.Request) {
    const ct = (req.headers.get('content-type') ?? '').toLowerCase();
    if (!ct.includes('application/json') && !ct.includes('+json')) {
      return ittyJson({ error: 'Content-Type must be application/json' }, { status: 415 });
    }
    return null;
  }

  async function withFormData(req: IRequest) {
    try {
      (req as any).content = await (req as globalThis.Request).formData();
    } catch {
      // leave content undefined if parsing fails
    }
  }

  const methodsToProxy = ['get', 'post', 'put', 'delete', 'patch', 'head', 'options'];

  const wrapper: any = new Proxy(r, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && methodsToProxy.includes(prop)) {
        return (
          path: string,
          controller: HandlerController<any, any, Args>,
          options?: RouteOptions,
        ) => {
          const handler = (...args: any[]) => {
            const req = args[0] as IRequest & { content?: unknown };
            const extraArgs = args.slice(1) as Args;
            if (prop === 'post' || prop === 'put' || prop === 'patch') {
              if (!options?.multipart) {
                const ctErr = enforceJson(req);
                if (ctErr) return ctErr;
              }
            }
            return controller(req as any, ...extraArgs);
          };

          const parse = options?.multipart ? withFormData : withContent;
          target[prop](path, ...(options?.use ?? []), parse, handler);

          const routeInfo = {
            path,
            method: prop,
            handler,
            // These are just markers for the generator to know they are there
            // We can't easily pass the actual type at runtime but we can pass names if we had them
          };

          Object.assign(handler, routeInfo);

          return handler;
        };
      }
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === 'function') {
        return (...args: any[]) => {
          const result = value.apply(target, args);
          return result === target ? wrapper : result;
        };
      }
      return value;
    },
  });

  return wrapper;
}
