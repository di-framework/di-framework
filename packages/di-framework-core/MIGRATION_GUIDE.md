# Core migration guide

## Definition-time bootstrap

`@Bootstrap()` is deprecated. It still registers and resolves its class while
the module is being evaluated in the 4.x line, but this ordering is implicit,
cannot await asynchronous setup, and makes cleanup difficult.

Move startup to the application entry point:

```typescript
// Before
@Bootstrap()
class Server {}

// After
class Server {
  async start() { /* bind the listener */ }
  async stop() { /* close the listener */ }
}

const application = ApplicationContext.builder()
  .bootstrap(Server);
await application.start();
```

`start()` is concurrency-safe and idempotent. Bootstrap hooks run in declaration
order. On startup failure, successfully started components are stopped in
reverse order and the context remains failed. `stop()` is also idempotent and
uses reverse startup order.

Use `ApplicationContext.builder(useContainer())` during incremental migration
when existing `@Container()` decorators still register services in the global
container. New applications can use the context-owned container and explicit
`@Configuration()` bean factories.
