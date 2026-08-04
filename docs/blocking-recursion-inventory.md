# Blocking recursion inventory (#83)

Inventory of **synchronous recursive** helpers that can block the event loop on
untrusted or large inputs. Decisions: **leave** / **bound** / **rewrite iterative**.

Status: after high-impact fixes landed with this document (see PR for #83).

## Summary table

| Package | Symbol | Hot path? | Max realistic depth | Untrusted input? | Decision |
| --- | --- | --- | --- | --- | --- |
| `di-framework-config` | `deepMerge` | Config load / merge | dozens (config files) | Y (files, env nesting) | **Bound** depth (default 64) + cycle detect |
| `di-framework-config` | `flattenEntries` | Config registration | dozens | Y | **Iterative** stack walk + depth/cycle bounds |
| `di-framework-auth` | `decodeValue` (CBOR) | WebAuthn attestation | ~4 | Y (binary) | **Leave** — already depth/element/string limited |
| `di-framework-ai` | `validateNode` (JSON Schema) | Structured output validation | schema author depth | Y (model JSON) | **Bound** depth (default 64) |
| `di-framework-ai` | `evaluateOperand` / filter eval | Vector filter apply | query AST | Y (filter text → AST) | **Bound** depth (default 64) |
| `di-framework-ai` | `parseFilterExpression` / `parseNot` | Filter parse | query text | Y | **Bound** parse depth (default 64) |
| `di-framework-graphql` | `stableStringify` | Batch keys | request values | Y | **Bound** + cycle detect |
| `di-framework-graphql` | `printLiteral` | SDL defaults | schema author | mostly N | **Bound** + cycle detect |
| `di-framework-graphql` | `coerceInput` | Request args | nested inputs | Y | **Bound** depth (64) |
| `di-framework-graphql` | `printTypeNode` / `namedTypeNode` / `printableType` | Schema print | list/nonNull wrappers | N (schema author) | **Leave** — inherently shallow |
| `di-framework-http` | `collectRefs` / `extractSchemaRefs` | OpenAPI build | doc size | mixed | **Bound** + visited set |
| `di-framework-http` | `resolveSchema` | OpenAPI build | component graph | mixed | **Leave** — already cycle-safe via `resolved` map |
| `di-framework-repo` | (none flagged) | — | — | — | **Leave** |

## Rationale

- Prefer **depth bounds + cycle detection** over “make everything async.”
- Untrusted trees (config, CBOR, model JSON, GraphQL args, filter text) get hard limits that throw clear errors.
- Schema-author graphs (`printTypeNode`, GraphQL type wrappers) stay recursive: depths are tiny and fixed by authors.
- CBOR already had production-grade limits; no change required beyond documentation.

## Public guarantees

| API | Guarantee |
| --- | --- |
| `deepMerge` / `flattenEntries` | Default max depth 64 (`DEFAULT_MAX_OBJECT_DEPTH`); cycles throw |
| `validateAgainstJsonSchema` | Default max depth 64 |
| `evaluateFilterExpression` / `parseFilterExpression` | Default max depth 64 |
| CBOR `decodeCbor*` | `maxDepth` default 16 (unchanged) |

## Out of scope (explicit)

- Full async yielding on every recursion (unnecessary for bounded trees)
- Rewriting GraphQL schema printers that only walk list/nonNull wrappers
- Performance work unrelated to recursion depth
