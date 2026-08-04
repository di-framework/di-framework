/**
 * Turns resolved fields into resolver functions.
 *
 * The rules are deliberately object-oriented:
 * - a portal field runs on an instance resolved from the DI container;
 * - a type field runs on the object itself — plain data coming back from a
 *   repository is re-hydrated onto the class so its methods and invariants
 *   apply;
 * - an action declared on a type loads the entity through its `@Lookup` and
 *   then invokes the method, so the invariant never leaves the object;
 * - a subscription reads the container's event bus, which is what
 *   `@Publisher` writes to.
 */

import { type Container, useContainer } from '@di-framework/core/container';
import { type AuthorizationOptions, denialToError, evaluateRequirements } from './authorization.ts';
import { type ConnectionArgs, toConnection } from './connection.ts';
import { BatchLoader } from './loader.ts';
import type {
  Ctor,
  GraphQLContext,
  ResolvedField,
  ResolvedInputType,
  TypeGraph,
  TypeNode,
} from './types.ts';

export interface ResolverOptions {
  /** Container used to resolve portals, extensions and event subscriptions. */
  container?: Container;
  graph: TypeGraph;
  /** How `@Requires` reads the principal off the request context. */
  authorization?: AuthorizationOptions;
}

interface RequestState {
  loaders: Map<string, BatchLoader<any, any>>;
  hydrated: WeakMap<object, Map<Ctor, any>>;
}

/** Per-request state, keyed on the context object so nothing is mutated. */
const REQUEST_STATE = new WeakMap<object, RequestState>();

/** Stand-in key for root fields, which have no parent. */
const ROOT_PARENT = Symbol.for('@di-framework/graphql-root-parent');

function getRequestState(ctx: unknown): RequestState | undefined {
  if (typeof ctx !== 'object' || ctx === null) return undefined;
  let state = REQUEST_STATE.get(ctx);
  if (!state) {
    state = { loaders: new Map(), hydrated: new WeakMap() };
    REQUEST_STATE.set(ctx, state);
  }
  return state;
}

/**
 * Give a plain object the behaviour of its semantic type.
 *
 * Repositories, HTTP payloads and JSON columns all produce structurally correct
 * but behaviour-free objects; hydration is what lets `@Field` methods and
 * `@Action` invariants keep working without forcing every data source to build
 * class instances.
 */
export function hydrate<T>(target: Ctor<T>, value: unknown, state?: RequestState): any {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  if (value instanceof target) return value;

  const cached = state?.hydrated.get(value as object)?.get(target);
  if (cached) return cached;

  const instance = Object.assign(Object.create(target.prototype), value);
  if (state) {
    const perTarget = state.hydrated.get(value as object) ?? new Map<Ctor, any>();
    perTarget.set(target, instance);
    state.hydrated.set(value as object, perTarget);
  }
  return instance;
}

/** Nesting limit for request-time value walks (batch keys / input trees). */
const STABLE_STRINGIFY_MAX_DEPTH = 64;

function stableStringify(value: unknown, depth = 0, seen?: WeakSet<object>): string {
  if (depth > STABLE_STRINGIFY_MAX_DEPTH) {
    throw new Error(`stableStringify exceeded max depth of ${STABLE_STRINGIFY_MAX_DEPTH}`);
  }
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  const visited = seen ?? new WeakSet<object>();
  if (visited.has(value as object)) {
    throw new Error('stableStringify detected a cyclic value');
  }
  visited.add(value as object);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item, depth + 1, visited)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item, depth + 1, visited)}`).join(',')}}`;
}

export class ResolverFactory {
  private readonly container: Container;
  private readonly authorization: AuthorizationOptions;
  private readonly inputsByName = new Map<string, ResolvedInputType>();
  /** Instances of classes that are not registered with the container. */
  private readonly unmanaged = new Map<Ctor, any>();

  constructor(private readonly options: ResolverOptions) {
    this.container = options.container ?? useContainer();
    this.authorization = options.authorization ?? {};
    for (const input of options.graph.inputs) this.inputsByName.set(input.name, input);
  }

  /** Resolver for a field, honouring holder rules, batching and hydration. */
  createResolver(
    field: ResolvedField,
  ): (parent: any, args: Record<string, any>, ctx: GraphQLContext, info: any) => any {
    const source = field.source;

    if ('constant' in source && source.constant !== undefined) {
      const { constant } = source;
      return () => constant;
    }

    if (source.entity) {
      return this.authorized(field, this.paginated(field, this.createEntityActionResolver(field)));
    }

    const argTypes = new Map(field.args.map((arg) => [arg.name, arg.type]));

    return this.authorized(
      field,
      this.paginated(field, (parent, args, ctx, info) => {
        const state = getRequestState(ctx);
        const holder = this.resolveHolder(field, parent, state);

        if (source.member === 'property') {
          return (holder as any)?.[source.propertyKey];
        }

        if (source.batch && state) {
          return this.loadBatched(field, argTypes, parent, args, ctx, info, state);
        }

        return this.invoke(holder, field, argTypes, parent, args, ctx, info);
      }),
    );
  }

  /**
   * Shape a `@Connection` field's result.
   *
   * A plain array is sliced against the incoming cursor arguments; a value that
   * already has connection shape — because the repository paged natively — is
   * passed through.
   */
  private paginated<T extends (parent: any, args: any, ctx: any, info: any) => any>(
    field: ResolvedField,
    resolver: T,
  ): T {
    const connection = field.source.connection;
    if (!connection) return resolver;

    const { defaultPageSize, maxPageSize } = connection;

    return ((parent: any, args: any, ctx: any, info: any) => {
      const requested = args.first ?? args.last;
      if (maxPageSize !== undefined && typeof requested === 'number' && requested > maxPageSize) {
        throw new Error(`Page size ${requested} exceeds the maximum of ${maxPageSize}.`);
      }
      const paging: ConnectionArgs = {
        ...args,
        first:
          args.first ??
          (args.last === undefined || args.last === null ? defaultPageSize : undefined),
      };

      const result = resolver(parent, args, ctx, info);
      return result && typeof result.then === 'function'
        ? result.then((value: unknown) => toConnection(value, paging))
        : toConnection(result, paging);
    }) as unknown as T;
  }

  /**
   * Gate a resolver behind the field's `@Requires` declarations.
   *
   * The check runs before the member is read or invoked — and before the entity
   * is loaded — so a denied caller never reaches the domain object at all.
   */
  private authorized<T extends (parent: any, args: any, ctx: any, info: any) => any>(
    field: ResolvedField,
    resolver: T,
  ): T {
    const requirements = field.source.requirements;
    if (!requirements || requirements.length === 0) return resolver;

    const path = `${field.source.target.name}.${field.name}`;
    return (async (parent: any, args: any, ctx: any, info: any) => {
      const denial = await evaluateRequirements(
        requirements,
        path,
        { parent, args, ctx, info },
        this.authorization,
      );
      if (denial) throw denialToError(denial, this.authorization);
      return resolver(parent, args, ctx, info);
    }) as unknown as T;
  }

  /** `subscribe` implementation for a `@Subscription` field. */
  createSubscribe(
    field: ResolvedField,
  ): (
    parent: any,
    args: Record<string, any>,
    ctx: GraphQLContext,
    info: any,
  ) => AsyncIterableIterator<any> {
    const subscription = field.source.subscription;
    if (!subscription) {
      throw new Error(`${field.name} is not a subscription field`);
    }

    const requirements = field.source.requirements;
    const path = `${field.source.target.name}.${field.name}`;

    return (_parent, args, ctx, info) => {
      const stream = () =>
        containerEventIterator(this.container, subscription.event, (payload) => {
          if (subscription.filter && !subscription.filter(payload, args, ctx)) return SKIP;
          if (subscription.map) return subscription.map(payload, args, ctx);
          return unwrapPublisherPayload(payload);
        });

      if (!requirements || requirements.length === 0) return stream();

      // Authorize before subscribing, so a denied caller never gets a stream.
      return deferredIterator(async () => {
        const denial = await evaluateRequirements(
          requirements,
          path,
          { parent: _parent, args, ctx, info },
          this.authorization,
        );
        if (denial) throw denialToError(denial, this.authorization);
        return stream();
      });
    };
  }

  /** Field resolver applied to each published event of a subscription. */
  createSubscriptionResolver(
    field: ResolvedField,
  ): (payload: any, args: Record<string, any>, ctx: GraphQLContext, info: any) => any {
    const source = field.source;
    if (source.member !== 'method') return (payload) => payload;

    const argTypes = new Map(field.args.map((arg) => [arg.name, arg.type]));
    return (payload, args, ctx, info) => {
      const holder = this.resolveHolder(field, payload, getRequestState(ctx));
      return this.invoke(holder, field, argTypes, payload, args, ctx, info);
    };
  }

  /* ---------------------------------------------------------------------- */

  private resolveHolder(
    field: ResolvedField,
    parent: any,
    state: RequestState | undefined,
  ): unknown {
    switch (field.source.holder) {
      case 'portal':
      case 'extension':
        return this.instanceOf(field.source.target);
      case 'parent':
        return hydrate(field.source.target, parent, state);
      default:
        return parent;
    }
  }

  /** Resolve a DI-managed class, falling back to construction for plain classes. */
  private instanceOf(target: Ctor): any {
    if (this.container.has(target)) return this.container.resolve(target);

    const cached = this.unmanaged.get(target);
    if (cached) return cached;

    let instance: any;
    try {
      instance = this.container.construct(target);
    } catch {
      instance = new target();
    }
    this.unmanaged.set(target, instance);
    return instance;
  }

  private invoke(
    holder: any,
    field: ResolvedField,
    argTypes: Map<string, TypeNode>,
    parent: any,
    args: Record<string, any>,
    ctx: GraphQLContext,
    info: any,
  ): any {
    const method = holder?.[field.source.propertyKey];
    if (typeof method !== 'function') {
      throw new Error(
        `${field.source.target.name}.${field.source.propertyKey} is not callable on the resolved instance.`,
      );
    }
    const call = () =>
      method.apply(holder, this.buildCallArgs(field, argTypes, parent, args, ctx, info));
    const middleware = field.source.middleware;
    if (!middleware) return call();
    const layers = Array.isArray(middleware) ? [...middleware] : [middleware];
    const run = (index: number): unknown => {
      const layer = layers[index];
      if (!layer) return call();
      return layer(() => run(index + 1), { parent, args, ctx, info, field });
    };
    return run(0);
  }

  private buildCallArgs(
    field: ResolvedField,
    argTypes: Map<string, TypeNode>,
    parent: any,
    args: Record<string, any>,
    ctx: GraphQLContext,
    info: any,
  ): any[] {
    const call: any[] = [];
    for (const param of field.source.params) {
      switch (param.kind) {
        case 'context':
          call[param.index] = ctx;
          break;
        case 'parent':
          call[param.index] = parent;
          break;
        case 'info':
          call[param.index] = info;
          break;
        default: {
          const name = param.name as string;
          const type = argTypes.get(name);
          call[param.index] = type ? this.coerceInput(args[name], type) : args[name];
        }
      }
    }
    return call;
  }

  /** Rebuild `@InputType` classes from the plain objects GraphQL hands us. */
  private coerceInput(value: any, type: TypeNode, depth = 0): any {
    const maxDepth = 64;
    if (depth > maxDepth) {
      throw new Error(`coerceInput exceeded max type/value depth of ${maxDepth}`);
    }
    if (value === null || value === undefined) return value;

    if (type.kind === 'nonNull') return this.coerceInput(value, type.of, depth + 1);
    if (type.kind === 'list') {
      return Array.isArray(value)
        ? value.map((item) => this.coerceInput(item, type.of, depth + 1))
        : value;
    }
    if (type.kind !== 'input') return value;

    const input = this.inputsByName.get(type.name);
    if (!input) return value;

    const instance: any = Object.create(input.target.prototype);
    for (const fieldDefinition of input.fields) {
      if (!(fieldDefinition.name in value)) continue;
      instance[fieldDefinition.propertyKey] = this.coerceInput(
        value[fieldDefinition.name],
        fieldDefinition.type,
        depth + 1,
      );
    }
    return instance;
  }

  private loadBatched(
    field: ResolvedField,
    argTypes: Map<string, TypeNode>,
    parent: any,
    args: Record<string, any>,
    ctx: GraphQLContext,
    info: any,
    state: RequestState,
  ): Promise<any> {
    const source = field.source;
    const cacheKey = `${source.target.name}.${source.propertyKey}::${stableStringify(args)}`;

    let loader = state.loaders.get(cacheKey);
    if (!loader) {
      loader = new BatchLoader<any, any>(async (keys) => {
        const parents = keys.map((key) => (key === ROOT_PARENT ? undefined : key));
        const holders = parents.map((value) =>
          source.holder === 'parent'
            ? hydrate(source.target, value, state)
            : this.instanceOf(source.target),
        );

        const batch = source.batch;
        if (batch === true) {
          return Promise.all(
            holders.map((holder, index) =>
              this.invoke(holder, field, argTypes, parents[index], args, ctx, info),
            ),
          );
        }

        // A field declared on the type batches over its own instances; a portal
        // or extension field batches over the parents it was handed.
        const batchParents = source.holder === 'parent' ? holders : parents;

        let batchFn: unknown = batch;
        let batchThis: unknown = source.target;
        if (typeof batch === 'string') {
          const instance = source.holder === 'parent' ? undefined : holders[0];
          if (instance && typeof (instance as any)[batch] === 'function') {
            batchFn = (instance as any)[batch];
            batchThis = instance;
          } else {
            batchFn = (source.target as any)[batch];
          }
        }
        if (typeof batchFn !== 'function') {
          throw new Error(
            `'${String(batch)}' is not a batch function for field '${field.name}' on ${source.target.name}.`,
          );
        }
        return (batchFn as Function).call(
          batchThis,
          batchParents,
          batchParents.map(() => args),
          ctx,
        );
      });
      state.loaders.set(cacheKey, loader);
    }

    return loader.load(parent ?? ROOT_PARENT);
  }

  private createEntityActionResolver(field: ResolvedField) {
    const source = field.source;
    const entity = source.entity!;
    const argTypes = new Map(field.args.map((arg) => [arg.name, arg.type]));

    return async (parent: any, args: Record<string, any>, ctx: GraphQLContext, info: any) => {
      const state = getRequestState(ctx);
      const key = args[entity.keyArg];
      const load = (entity.lookup.target as any)[entity.lookup.propertyKey];
      if (typeof load !== 'function') {
        throw new Error(
          `${entity.lookup.target.name}.${entity.lookup.propertyKey} is not a static @Lookup method.`,
        );
      }

      const loaded = await load.call(entity.lookup.target, key, ctx, info);
      if (loaded === null || loaded === undefined) {
        throw new Error(`${entity.typeName} '${String(key)}' was not found.`);
      }

      const instance = hydrate(source.target, loaded, state);
      const result = await this.invoke(instance, field, argTypes, parent, args, ctx, info);
      return entity.returnsSelf && result === undefined ? instance : result;
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Subscriptions                                                              */
/* -------------------------------------------------------------------------- */

const SKIP = Symbol.for('@di-framework/graphql-skip-event');

/**
 * `@Publisher` emits `{ className, methodName, args, result, ... }`. For a
 * subscription the interesting part is the return value, so unwrap it unless
 * the field declares its own `map`.
 */
function unwrapPublisherPayload(payload: any): any {
  if (
    payload &&
    typeof payload === 'object' &&
    'className' in payload &&
    'methodName' in payload &&
    'result' in payload
  ) {
    return payload.result;
  }
  return payload;
}

/**
 * An iterator whose source is decided on first `next()`.
 *
 * Lets an async authorization check run before the underlying subscription is
 * opened while still handing `subscribe` a synchronous iterator.
 */
function deferredIterator(open: () => Promise<AsyncIterableIterator<any>>) {
  let source: AsyncIterableIterator<any> | undefined;
  const ensure = async () => {
    source ??= await open();
    return source;
  };
  return {
    async next(): Promise<IteratorResult<any>> {
      return (await ensure()).next();
    },
    async return(): Promise<IteratorResult<any>> {
      return (await source?.return?.()) ?? { value: undefined, done: true };
    },
    async throw(error: unknown): Promise<IteratorResult<any>> {
      if (source?.throw) return source.throw(error);
      throw error;
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  } as AsyncIterableIterator<any>;
}

/** Bridge container events onto an async iterator for GraphQL subscriptions. */
export function containerEventIterator(
  container: Container,
  event: string,
  transform: (payload: any) => any,
): AsyncIterableIterator<any> {
  const pending: any[] = [];
  const waiting: Array<(result: IteratorResult<any>) => void> = [];
  let closed = false;

  const unsubscribe = container.on(event, (payload: any) => {
    if (closed) return;
    const value = transform(payload);
    if (value === SKIP) return;
    const next = waiting.shift();
    if (next) next({ value, done: false });
    else pending.push(value);
  });

  const finish = (): Promise<IteratorResult<any>> => {
    if (!closed) {
      closed = true;
      unsubscribe();
      while (waiting.length > 0) waiting.shift()!({ value: undefined, done: true });
    }
    return Promise.resolve({ value: undefined, done: true });
  };

  return {
    next(): Promise<IteratorResult<any>> {
      if (pending.length > 0) return Promise.resolve({ value: pending.shift(), done: false });
      if (closed) return Promise.resolve({ value: undefined, done: true });
      return new Promise((resolve) => waiting.push(resolve));
    },
    return: finish,
    throw(error: unknown): Promise<IteratorResult<any>> {
      void finish();
      return Promise.reject(error);
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}
