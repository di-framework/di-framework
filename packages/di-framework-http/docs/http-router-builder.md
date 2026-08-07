# HttpRouter Builder & `@HttpRouter` Decorator (`@di-framework/http`)

## Overview

`@di-framework/http` provides an additive, fluent **`HttpRouter.builder()`** and an **`@HttpRouter()`** decorator above `TypedRouter()`.

The low-level `TypedRouter()` factory remains 100% supported and unchanged. The builder provides a single, structured point for configuring prefixes, global middleware, error handling, DI integration, and pluggable auth extensions.

---

## Usage Examples

### 1. Fluent Builder (`HttpRouter.builder()`)

```ts
import { HttpRouter } from '@di-framework/http';

const http = HttpRouter.builder()
  .prefix('/api')
  .use(loggingMiddleware)
  .catch((err) => new Response(JSON.stringify({ error: err.message }), { status: 500 }))
  .build();

http.get('/health', async () => new Response('OK'));
http.post('/users', async (req) => json({ id: '1' }));

// Compatibility with web Request handling
const response = await http.fetch(new Request('https://example.com/api/health'));
```

### 2. Decorator Integration (`@HttpRouter()`)

```ts
import { HttpRouter } from '@di-framework/http';
import { useContainer } from '@di-framework/core/container';

@HttpRouter({
  prefix: '/v1',
  use: [requestTracker],
  catch: customErrorHandler,
})
export class ApiRouter {}

// Resolve through DI container
const container = useContainer();
const routerInstance = container.resolve('HTTP_ROUTER');
```

### 3. Optional Auth Integration (`withAuthRoutes`)

```ts
import { HttpRouter } from '@di-framework/http';
import { withAuthRoutes } from '@di-framework/auth/http';

const http = HttpRouter.builder()
  .prefix('/api')
  .extend((builder, router) => {
    (router as any).secure = withAuthRoutes(router);
  })
  .build();

http.secure.get('/me', async (req) => json({ sub: req.principal.sub }));
```

---

## When to Use Which API

| API | When to Use |
| :--- | :--- |
| **`TypedRouter()`** | Lightweight factory when zero overhead or manual composition is required. |
| **`HttpRouter.builder()`** | Programmatic application bootstrap requiring prefixes, middleware, and error handling. |
| **`@HttpRouter()`** | Class-based DI applications where the router is managed by the dependency injection container. |
