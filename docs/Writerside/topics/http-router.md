# HTTP Router

Lightweight TypeScript decorators and a type-safe router for [itty-router](https://github.com/kwhitley/itty-router). Includes a build-time OpenAPI 3.1 generator. Ported from `itty-decorators`.

## Features

- **Type-Safe Routing**: `TypedRouter` provides full TypeScript support for request bodies, response types, and context.
- **Auto JSON Enforcement**: Automatically validates `Content-Type: application/json` for mutation methods (POST, PUT, PATCH).
- **Multipart Support**: Opt into `multipart/form-data` handling with `Multipart<T>` and `{ multipart: true }`.
- **Declarative Metadata**: Use `@Controller` and `@Endpoint` decorators to document your API logic directly in code.
- **DI Integration**: `@Controller` composes the core DI `@Container` decorator, so controllers are auto-registered and can use `@Component` injection and `useContainer().resolve(...)`.
- **OpenAPI 3.1 Support**: Generate a complete OpenAPI specification from your code at build time.
- **Minimal Footprint**: Built on top of the ultra-light `itty-router`.

## Installation

```bash
# Install the HTTP package and the core DI framework (peer dependency)
bun add @di-framework/di-framework-http @di-framework/di-framework
# or
npm install @di-framework/di-framework-http @di-framework/di-framework
```

## Quick Start

### 1. Create a Controller (DI-aware)

Annotate your API logic using decorators and the `TypedRouter`. Controllers are automatically registered with the DI container, so you can inject services and resolve the controller instance.

```typescript
import {
  TypedRouter,
  json,
  type RequestSpec,
  type ResponseSpec,
  type Json,
  Controller,
  Endpoint,
} from '@di-framework/di-framework-http';
import { Component, Container } from '@di-framework/di-framework/decorators';
import { useContainer } from '@di-framework/di-framework/container';

const router = TypedRouter();

type EchoPayload = { message: string };
type EchoResponse = { echoed: string; timestamp: string };

// Example DI-managed service
@Container()
export class LoggerService {
  log(msg: string) {
    console.log(msg);
  }
}

@Controller()
export class EchoController {
  // Because @Controller composes the core @Container decorator, this class is
  // automatically registered with the DI container. We can inject services.
  @Component(LoggerService)
  private logger!: LoggerService;

  echoMessage(message: string): EchoResponse {
    this.logger.log(`Echoing: ${message}`);
    return { echoed: message, timestamp: new Date().toISOString() };
  }

  @Endpoint({
    summary: 'Echo a message',
    description: 'Returns the provided message with a server timestamp.',
    responses: {
      '200': { description: 'Successful echo' },
    },
  })
  static post = router.post<RequestSpec<Json<EchoPayload>>, ResponseSpec<EchoResponse>>(
    '/echo',
    (req) => {
      // Demonstrate auto DI registration: resolve the controller instance from
      // the global container without any manual registration.
      const controller = useContainer().resolve(EchoController);
      return json(controller.echoMessage(req.content.message));
    },
  );
}

// Add a simple GET route
router.get('/', () => json({ message: 'API is healthy' }));

export default {
  fetch: (request: Request, env: any, ctx: any) => router.fetch(request, env, ctx),
};
```

### 2. Multipart File Uploads

Use `Multipart<T>` and `{ multipart: true }` to accept `multipart/form-data` instead of JSON. The handler receives `req.content` typed as `FormData`.

```typescript
import {
  TypedRouter,
  json,
  type RequestSpec,
  type ResponseSpec,
  type Multipart,
} from '@di-framework/di-framework-http';

const router = TypedRouter();

type UploadPayload = { files: File[] };
type UploadResult = { filenames: string[] };

router.post<RequestSpec<Multipart<UploadPayload>>, ResponseSpec<UploadResult>>(
  '/upload',
  (req) => {
    // req.content is typed as FormData
    const files = req.content.getAll('files') as File[];
    return json({ filenames: files.map((f) => f.name) });
  },
  { multipart: true },
);
```

### 3. Path and Query Parameters

Use `PathParams<T>` and `QueryParams<T>` combined with `RequestSpec<...>` to provide strong typing for URL path parameters (e.g., `/user/:id`) and query string parameters (e.g., `?search=term`). The handler will receive them in `req.params` and `req.query`.

```typescript
import {
  TypedRouter,
  json,
  type RequestSpec,
  type ResponseSpec,
  type PathParams,
  type QueryParams,
} from '@di-framework/di-framework-http';

const router = TypedRouter();

type UserPathParams = { id: string };
type UserQueryParams = { includeDetails?: string };
type UserResponse = { id: string; detailsIncluded: boolean };

router.get<
  RequestSpec<PathParams<UserPathParams> & QueryParams<UserQueryParams>>,
  ResponseSpec<UserResponse>
>('/user/:id', (req) => {
  // req.params is typed as { id: string }
  const id = req.params.id;

  // req.query is typed as { includeDetails?: string | string[] }
  const detailsIncluded = req.query.includeDetails === 'true';

  return json({ id, detailsIncluded });
});
```

### OpenAPI Generation

`@di-framework/di-framework-http` provides a built-in CLI and a registry to generate OpenAPI specs from your controllers.

#### Using the CLI

The easiest way to generate a spec is using the provided CLI tool.

```bash
# Generate openapi.json from your controllers
bun x di-framework-http generate --controllers ./src/index.ts
```

**Options:**

- `--controllers <path>`: (Required) Path to the file that imports all your decorated controllers.
- `--output <path>`: (Optional) Path to save the generated JSON (default: `openapi.json`).

#### Manual Generation

You can also generate the spec programmatically using the `generateOpenAPI` function and the default `registry`:

```typescript
import registry, { generateOpenAPI } from '@di-framework/di-framework-http';
import './controllers/MyController'; // Import to trigger registration

const spec = generateOpenAPI(
  {
    title: 'My API',
    version: '1.0.0',
  },
  registry,
);

console.log(JSON.stringify(spec, null, 2));
```

If you need full control, you can iterate the `registry` manually:

```typescript
import registry from '@di-framework/di-framework-http';

for (const target of registry.getTargets()) {
  // target is the decorated class
  // target[methodName].isEndpoint will be true
  // target[methodName].metadata contains your @Endpoint info
}
```

## API Reference

### `TypedRouter<Args[]>()`

A proxy for `itty-router` that enables type-safe method definitions.

- `Args`: An array of types representing additional arguments passed to `fetch` (e.g., `[Env, ExecutionContext]`).

### `json<T>(data: T, init?: ResponseInit)`

A typed wrapper around itty-router's `json` helper.

### `Json<T>` / `Multipart<T>`

Body spec markers used with `RequestSpec<>` to declare the expected content type. `Json<T>` types `req.content` as `T`; `Multipart<T>` types it as `FormData`. Multipart routes require passing `{ multipart: true }` as the third argument to the route method.

### `PathParams<T>` / `QueryParams<T>`

Spec markers used with `RequestSpec<>` to declare the expected type of path and query parameters. `PathParams<T>` types `req.params` as `T`; `QueryParams<T>` types `req.query` as `T`.

### `@Controller(options?)`

Composed decorator that:

- Marks a class for inclusion in the OpenAPI registry; and
- Registers the class with the core DI container (same instance as `@di-framework/di-framework`).

**Options:** `{ singleton?: boolean; container?: DIContainer }`

### `@Endpoint(metadata)`

Method or property decorator that attaches OpenAPI metadata.

- `summary`: Short summary of the operation.
- `description`: Verbose explanation.
- `requestBody`: OpenAPI Request Body object.
- `responses`: OpenAPI Responses object.
