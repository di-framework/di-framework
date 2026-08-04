/**
 * Executable schema.
 *
 * The only module that imports `graphql`. Everything semantic has already been
 * decided by {@link buildTypeGraph}; this maps the resolved graph onto
 * `graphql-js` types and attaches the resolvers.
 */

import type { Container } from '@di-framework/core/container';
import {
  type ASTNode,
  type DocumentNode,
  type ExecutionResult,
  execute,
  GraphQLBoolean,
  GraphQLEnumType,
  GraphQLError,
  type GraphQLFieldConfigArgumentMap,
  type GraphQLFieldConfigMap,
  GraphQLFloat,
  GraphQLID,
  GraphQLInputObjectType,
  type GraphQLInputType,
  GraphQLInt,
  GraphQLList,
  type GraphQLNamedType,
  GraphQLNonNull,
  GraphQLObjectType,
  type GraphQLOutputType,
  GraphQLScalarType,
  GraphQLSchema,
  GraphQLString,
  type GraphQLType,
  Kind,
  parse,
  subscribe,
  validate,
} from 'graphql';
import { SemanticSchemaError } from './errors.ts';
import { ResolverFactory } from './resolvers.ts';
import { registerScalarName, type ScalarRef } from './scalars.ts';
import { type PrintOptions, printSDL } from './sdl.ts';
import { buildTypeGraph } from './type-graph.ts';
import type {
  BuildOptions,
  GraphQLContext,
  ResolvedArg,
  ResolvedField,
  TypeGraph,
  TypeNode,
} from './types.ts';

/* -------------------------------------------------------------------------- */
/* Custom scalars                                                             */
/* -------------------------------------------------------------------------- */

/** Convert a literal AST node to a plain JS value (used by the JSON scalar). */
function literalToValue(node: ASTNode): unknown {
  switch (node.kind) {
    case Kind.NULL:
      return null;
    case Kind.INT:
      return Number.parseInt(node.value, 10);
    case Kind.FLOAT:
      return Number.parseFloat(node.value);
    case Kind.BOOLEAN:
      return node.value;
    case Kind.STRING:
    case Kind.ENUM:
      return node.value;
    case Kind.LIST:
      return node.values.map(literalToValue);
    case Kind.OBJECT:
      return Object.fromEntries(
        node.fields.map((field) => [field.name.value, literalToValue(field.value)]),
      );
    default:
      return null;
  }
}

const DateTimeScalar = new GraphQLScalarType({
  name: 'DateTime',
  description: 'An ISO-8601 date-time string.',
  serialize(value) {
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'string') return value;
    if (typeof value === 'number') return new Date(value).toISOString();
    throw new TypeError(`DateTime cannot represent value: ${String(value)}`);
  },
  parseValue(value) {
    if (typeof value === 'string' || typeof value === 'number') return new Date(value);
    throw new TypeError(`DateTime cannot parse value: ${String(value)}`);
  },
  parseLiteral(node) {
    if (node.kind === Kind.STRING) return new Date(node.value);
    throw new TypeError('DateTime must be a string');
  },
});

const JSONScalar = new GraphQLScalarType({
  name: 'JSON',
  description: 'Arbitrary JSON. An escape hatch — prefer real semantic types.',
  serialize: (value) => value,
  parseValue: (value) => value,
  parseLiteral: (node) => literalToValue(node),
});

const SPEC_SCALAR_TYPES: Record<string, GraphQLScalarType> = {
  ID: GraphQLID,
  String: GraphQLString,
  Int: GraphQLInt,
  Float: GraphQLFloat,
  Boolean: GraphQLBoolean,
  DateTime: DateTimeScalar,
  JSON: JSONScalar,
};

/** Application scalar implementations keyed by their GraphQL name. */
const REGISTERED_SCALARS = new Map<string, GraphQLScalarType>();

/**
 * Register an application-defined scalar implementation.
 *
 * Use the returned `ScalarRef` in `@Field`/`@Arg` declarations. Registration
 * is process-wide, matching the decorator registry, and can be performed once
 * during application startup before `buildSemanticSchema()`.
 */
export function registerScalar(name: string, scalar: GraphQLScalarType): ScalarRef {
  const ref = registerScalarName(name);
  REGISTERED_SCALARS.set(name, scalar);
  return ref;
}

/* -------------------------------------------------------------------------- */
/* Schema assembly                                                            */
/* -------------------------------------------------------------------------- */

export interface SemanticSchemaOptions extends BuildOptions {
  /** Container used to resolve portals and read the event bus. */
  container?: Container;
  /** Options for the SDL rendered onto `SemanticSchema.sdl`. */
  print?: PrintOptions;
  /** Optional query resource limits enforced before execution. */
  maxDepth?: number;
  maxComplexity?: number;
  /** Transform execution/validation errors before they leave the API. */
  errorFormatter?: (error: GraphQLError) => GraphQLError;
}

export interface ExecuteRequest {
  query: string;
  variables?: Record<string, unknown> | null;
  operationName?: string | null;
  /** Per-request context. Defaults to `{}` so request-scoped batching works. */
  context?: GraphQLContext;
  rootValue?: unknown;
}

export interface SemanticSchema {
  /** The resolved, validated semantic graph. */
  graph: TypeGraph;
  /** Executable `graphql-js` schema. */
  schema: GraphQLSchema;
  /** SDL for the same graph. */
  sdl: string;
  /** Bounded contexts represented in the schema. */
  contexts: string[];
  execute(request: ExecuteRequest): Promise<ExecutionResult>;
  subscribe(
    request: ExecuteRequest,
  ): Promise<AsyncIterableIterator<ExecutionResult> | ExecutionResult>;
}

class SchemaAssembler {
  private readonly factory: ResolverFactory;
  private readonly named = new Map<string, GraphQLNamedType>();

  constructor(
    private readonly graph: TypeGraph,
    options: SemanticSchemaOptions,
  ) {
    this.factory = new ResolverFactory({ container: options.container, graph });
  }

  assemble(): GraphQLSchema {
    for (const enumType of this.graph.enums) {
      this.named.set(
        enumType.name,
        new GraphQLEnumType({
          name: enumType.name,
          description: enumType.description,
          values: Object.fromEntries(
            enumType.values.map((value) => [value.name, { value: value.value }]),
          ),
        }),
      );
    }

    for (const input of this.graph.inputs) {
      this.named.set(
        input.name,
        new GraphQLInputObjectType({
          name: input.name,
          description: input.description,
          fields: () =>
            Object.fromEntries(
              input.fields.map((field) => [
                field.name,
                { type: this.toInputType(field.type), description: field.description },
              ]),
            ),
        }),
      );
    }

    for (const object of this.graph.objects) {
      this.named.set(
        object.name,
        new GraphQLObjectType({
          name: object.name,
          description: object.description,
          extensions: {
            diFramework: {
              context: object.context,
              boundary: object.boundary,
              key: object.key,
            },
          },
          fields: () => this.toFieldConfigMap(object.fields),
        }),
      );
    }

    const query = new GraphQLObjectType({
      name: 'Query',
      fields: () => this.toFieldConfigMap(this.graph.query.fields),
    });

    const mutation = this.graph.mutation
      ? new GraphQLObjectType({
          name: 'Mutation',
          fields: () => this.toFieldConfigMap(this.graph.mutation!.fields),
        })
      : undefined;

    const subscription = this.graph.subscription
      ? new GraphQLObjectType({
          name: 'Subscription',
          fields: () => this.toFieldConfigMap(this.graph.subscription!.fields, true),
        })
      : undefined;

    return new GraphQLSchema({
      query,
      mutation,
      subscription,
      types: Array.from(this.named.values()),
    });
  }

  private toFieldConfigMap(
    fields: ResolvedField[],
    isSubscription = false,
  ): GraphQLFieldConfigMap<any, any> {
    const map: GraphQLFieldConfigMap<any, any> = {};
    for (const field of fields) {
      map[field.name] = {
        type: this.toOutputType(field.type),
        description: field.description,
        deprecationReason: field.deprecationReason,
        args: this.toArgs(field.args),
        extensions: {
          diFramework: {
            context: field.context,
            batch: field.source.batch !== undefined,
            holder: field.source.holder,
          },
        },
        ...(isSubscription
          ? {
              subscribe: this.factory.createSubscribe(field) as any,
              resolve: this.factory.createSubscriptionResolver(field),
            }
          : { resolve: this.factory.createResolver(field) }),
      };
    }
    return map;
  }

  private toArgs(args: ResolvedArg[]): GraphQLFieldConfigArgumentMap {
    const map: GraphQLFieldConfigArgumentMap = {};
    for (const arg of args) {
      map[arg.name] = {
        type: this.toInputType(arg.type),
        description: arg.description,
        defaultValue: arg.defaultValue,
      };
    }
    return map;
  }

  private toOutputType(node: TypeNode): GraphQLOutputType {
    return this.toType(node) as GraphQLOutputType;
  }

  private toInputType(node: TypeNode): GraphQLInputType {
    return this.toType(node) as GraphQLInputType;
  }

  private toType(node: TypeNode): GraphQLType {
    switch (node.kind) {
      case 'nonNull':
        return new GraphQLNonNull(this.toType(node.of) as any);
      case 'list':
        return new GraphQLList(this.toType(node.of));
      case 'scalar': {
        const scalar = SPEC_SCALAR_TYPES[node.name] ?? REGISTERED_SCALARS.get(node.name);
        if (!scalar) throw new SemanticSchemaError(`Unknown scalar '${node.name}'.`);
        return scalar;
      }
      default: {
        const named = this.named.get(node.name);
        if (!named) throw new SemanticSchemaError(`Type '${node.name}' was never assembled.`);
        return named;
      }
    }
  }
}

function queryCost(document: DocumentNode): { depth: number; complexity: number } {
  const fragments = new Map<string, any>();
  for (const definition of document.definitions) {
    if (definition.kind === Kind.FRAGMENT_DEFINITION)
      fragments.set(definition.name.value, definition);
  }
  const walk = (
    selectionSet: any,
    active: Set<string>,
    level: number,
  ): { depth: number; complexity: number } => {
    let depth = level;
    let complexity = 0;
    for (const selection of selectionSet?.selections ?? []) {
      if (selection.kind === Kind.FRAGMENT_SPREAD) {
        if (active.has(selection.name.value)) continue;
        const next = new Set(active).add(selection.name.value);
        const fragment = fragments.get(selection.name.value);
        const nested = fragment
          ? walk(fragment.selectionSet, next, level)
          : { depth: level, complexity: 0 };
        depth = Math.max(depth, nested.depth);
        complexity += nested.complexity;
        continue;
      }
      if (selection.kind === Kind.INLINE_FRAGMENT) {
        const nested = walk(selection.selectionSet, active, level);
        depth = Math.max(depth, nested.depth);
        complexity += nested.complexity;
        continue;
      }
      complexity += 1;
      const nested = walk(selection.selectionSet, active, level + 1);
      depth = Math.max(depth, nested.depth);
      complexity += nested.complexity;
    }
    return { depth, complexity };
  };
  let result = { depth: 0, complexity: 0 };
  for (const definition of document.definitions) {
    if (definition.kind !== Kind.OPERATION_DEFINITION) continue;
    const current = walk(definition.selectionSet, new Set(), 0);
    result = {
      depth: Math.max(result.depth, current.depth),
      complexity: Math.max(result.complexity, current.complexity),
    };
  }
  return result;
}

/**
 * Build the executable schema from every decorated class.
 *
 * @example
 * ```ts
 * const api = buildSemanticSchema();
 * const result = await api.execute({ query: '{ me { displayName } }', context: { userId: '1' } });
 * ```
 */
export function buildSemanticSchema(options: SemanticSchemaOptions = {}): SemanticSchema {
  const graph = buildTypeGraph(options);
  const schema = new SchemaAssembler(graph, options).assemble();
  const sdl = printSDL(graph, options.print);

  const prepare = (request: ExecuteRequest) => {
    const document = parse(request.query);
    const errors = [...validate(schema, document)];
    if (errors.length === 0) {
      const cost = queryCost(document);
      if (options.maxDepth !== undefined && cost.depth > options.maxDepth) {
        errors.push(
          new GraphQLError(
            `Query depth ${cost.depth} exceeds the configured maximum of ${options.maxDepth}.`,
            { extensions: { code: 'QUERY_DEPTH_LIMIT' } },
          ),
        );
      }
      if (options.maxComplexity !== undefined && cost.complexity > options.maxComplexity) {
        errors.push(
          new GraphQLError(
            `Query complexity ${cost.complexity} exceeds the configured maximum of ${options.maxComplexity}.`,
            { extensions: { code: 'QUERY_COMPLEXITY_LIMIT' } },
          ),
        );
      }
    }
    return { document, errors };
  };

  const formatResult = (result: ExecutionResult): ExecutionResult => {
    if (!options.errorFormatter || !result.errors) return result;
    return { ...result, errors: result.errors.map(options.errorFormatter) };
  };

  return {
    graph,
    schema,
    sdl,
    contexts: graph.contexts,

    async execute(request) {
      const { document, errors } = prepare(request);
      if (errors.length > 0)
        return { errors: errors.map(options.errorFormatter ?? ((error) => error)) };
      return formatResult(
        await execute({
          schema,
          document,
          contextValue: request.context ?? {},
          variableValues: request.variables ?? undefined,
          operationName: request.operationName ?? undefined,
          rootValue: request.rootValue,
        }),
      );
    },

    async subscribe(request) {
      const { document, errors } = prepare(request);
      if (errors.length > 0)
        return { errors: errors.map(options.errorFormatter ?? ((error) => error)) };
      const result = (await subscribe({
        schema,
        document,
        contextValue: request.context ?? {},
        variableValues: request.variables ?? undefined,
        operationName: request.operationName ?? undefined,
        rootValue: request.rootValue,
      })) as AsyncIterableIterator<ExecutionResult> | ExecutionResult;
      if (typeof (result as any)?.[Symbol.asyncIterator] === 'function') {
        const iterator = result as AsyncIterableIterator<ExecutionResult>;
        return (async function* () {
          for await (const item of iterator) yield formatResult(item);
        })();
      }
      return formatResult(result as ExecutionResult);
    },
  };
}

/* -------------------------------------------------------------------------- */
/* HTTP                                                                       */
/* -------------------------------------------------------------------------- */

export interface HandlerOptions {
  /** Build the per-request context. Receives the incoming request. */
  context?: (request: Request) => GraphQLContext | Promise<GraphQLContext>;
}

/** Options for the lightweight GraphQL-over-SSE subscription endpoint. */
export interface SubscriptionHandlerOptions extends HandlerOptions {
  /** Keep the stream open with periodic SSE comments (milliseconds). */
  heartbeatMs?: number;
}

/** Minimal router surface accepted by {@link mountGraphQL}. */
export interface GraphQLRouterLike {
  get(
    path: string,
    handler: (request: Request, ...rest: any[]) => unknown,
    ...rest: any[]
  ): unknown;
  post(
    path: string,
    handler: (request: Request, ...rest: any[]) => unknown,
    ...rest: any[]
  ): unknown;
}

export interface GraphQLRouteOptions extends HandlerOptions {
  /** Route path. Defaults to `/graphql`. */
  path?: string;
}

/**
 * A `Request -> Response` GraphQL endpoint, ready to drop into `Bun.serve`,
 * a Cloudflare Worker, or `@di-framework/http`.
 */
export function createGraphQLHandler(
  api: SemanticSchema,
  options: HandlerOptions = {},
): (request: Request) => Promise<Response> {
  const json = (body: unknown, status: number) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  return async (request: Request): Promise<Response> => {
    let payload: ExecuteRequest;

    if (request.method === 'GET') {
      const url = new URL(request.url);
      const query = url.searchParams.get('query');
      if (!query) return json({ errors: [{ message: 'Missing "query" parameter' }] }, 400);
      const variables = url.searchParams.get('variables');
      payload = {
        query,
        variables: variables ? JSON.parse(variables) : undefined,
        operationName: url.searchParams.get('operationName'),
      };
    } else if (request.method === 'POST') {
      try {
        const body = (await request.json()) as ExecuteRequest;
        if (!body || typeof body.query !== 'string') {
          return json({ errors: [{ message: 'Missing "query" in request body' }] }, 400);
        }
        payload = body;
      } catch {
        return json({ errors: [{ message: 'Request body is not valid JSON' }] }, 400);
      }
    } else {
      return json({ errors: [{ message: `Method ${request.method} not allowed` }] }, 405);
    }

    const context = options.context ? await options.context(request) : {};
    const result = await api.execute({ ...payload, context });
    return json(result, result.data === undefined && result.errors ? 400 : 200);
  };
}

/**
 * Mount a semantic schema on any Fetch-compatible typed router (including
 * `@di-framework/http`'s `TypedRouter`). Both GET and POST GraphQL-over-HTTP
 * routes are registered and the router is returned for fluent composition.
 */
export function mountGraphQL<R extends GraphQLRouterLike>(
  router: R,
  api: SemanticSchema,
  options: GraphQLRouteOptions = {},
): R {
  const { path = '/graphql', ...handlerOptions } = options;
  const handler = createGraphQLHandler(api, handlerOptions);
  router.get(path, handler);
  router.post(path, handler);
  return router;
}

/**
 * Serve GraphQL subscriptions over Server-Sent Events. The endpoint accepts a
 * GET request with the standard `query`, `variables`, and `operationName`
 * parameters and emits `data` events until the client aborts the request.
 */
export function createGraphQLSSEHandler(
  api: SemanticSchema,
  options: SubscriptionHandlerOptions = {},
): (request: Request) => Promise<Response> {
  return async (request) => {
    if (request.method !== 'GET') {
      return new Response(JSON.stringify({ errors: [{ message: 'Subscriptions require GET' }] }), {
        status: 405,
        headers: { 'content-type': 'application/json' },
      });
    }
    const url = new URL(request.url);
    const query = url.searchParams.get('query');
    if (!query) return new Response('Missing "query" parameter', { status: 400 });
    const variables = url.searchParams.get('variables');
    const context = options.context ? await options.context(request) : {};
    const result = await api.subscribe({
      query,
      variables: variables ? JSON.parse(variables) : undefined,
      operationName: url.searchParams.get('operationName'),
      context,
    });
    if (!Symbol.asyncIterator || typeof (result as any)?.[Symbol.asyncIterator] !== 'function') {
      return new Response(JSON.stringify(result), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    }
    const iterator = result as AsyncIterableIterator<ExecutionResult>;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        let heartbeat: ReturnType<typeof setInterval> | undefined;
        if (options.heartbeatMs && options.heartbeatMs > 0) {
          heartbeat = setInterval(() => controller.enqueue(encoder.encode(': heartbeat\n\n')), options.heartbeatMs);
        }
        try {
          for await (const item of iterator) {
            controller.enqueue(encoder.encode(`event: next\ndata: ${JSON.stringify(item)}\n\n`));
          }
          controller.enqueue(encoder.encode('event: complete\ndata: {}\n\n'));
          controller.close();
        } catch (error) {
          controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ errors: [{ message: String(error) }] })}\n\n`));
          controller.close();
        } finally {
          if (heartbeat) clearInterval(heartbeat);
        }
      },
      async cancel() {
        await iterator.return?.();
      },
    });
    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      },
    });
  };
}

export { DateTimeScalar, JSONScalar };
