# Static / free-function convention (#85)

Prefer **static methods or free functions for pure work**; keep **instance methods** for stateful services, fluent builders, and domain behavior.

This is **not** “make everything static” and **not** a static service locator.

## When to use what

| Prefer | For |
| --- | --- |
| `static of(...)` / `static create(...)` / `static builder(...)` | Alternate constructors and factories (AI style) |
| Free functions | Pure helpers with no type ownership (`deepMerge`, `throwIfAborted`, `printTypeNode`, `chainWorkflow`) |
| **Static** `@Lookup` | GraphQL entity loaders (required by the schema builder) |
| Instance methods | DI-managed services, repositories, fluent builders with mutable state, GraphQL `@Field` / `@Action`, anything that needs `this` |

## Examples already in tree

- AI: `ChatAgent.create` / `fromBuilder`, `ChatResponse.of`, `Prompt.of`, `SimpleVectorStore.of` / `builder`, `GraphWorkflow.builder` / `of`, `PlannerExecutorWorkflow.of`, `A2ABus.create`
- GraphQL: static `@Lookup` only; instance `@Field` / `@Action`
- Config / utils: free functions for pure path/merge helpers

## Anti-patterns

- Moving container resolves into statics (“service locator”)
- Making domain `@Field` methods static
- Codemodding the whole monorepo without a clear win
- Breaking public APIs for style only (use free-function aliases or `static of` alongside constructors)

## Audit note (AI / GraphQL / config / repo)

| Area | Finding |
| --- | --- |
| `di-framework-ai` | Factories largely follow `static of` / free functions. Fixed workflows historically used only constructors + free-function factories; aligned with `static of` where missing. Converters hold instance schema state — correctly instance. |
| `di-framework-graphql` | Static `@Lookup` enforced; field resolvers instance. No high-confidence pure instance helpers to convert. |
| `di-framework-config` | Pure helpers already free functions (`deepMerge`, `flattenEntries`, …). Source `load()` methods are intentionally instance (closure over options). |
| `di-framework-repo` | Adapter/repository methods are stateful (connection, entity metadata) — leave instance. |

**High-confidence conversions in the companion PR:** add `static of` on fixed AI workflows that already had free-function factories, for consistency with `ChatAgent` / `GraphWorkflow` / `PlannerExecutorWorkflow`.
