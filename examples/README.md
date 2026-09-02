# Examples

Most Bun/npm examples use `@di-framework/cli` for application builds and checks,
with `@di-framework/tsc` configured as the TypeScript transformer. Examples
without DI decorators may use plain `tsc`. From this directory, run the aggregate
type check with:

```bash
bun run check
```

The root examples workspace runs one aggregate type check. Its `build` script
visits every nested example, running `bun run build` for package-based examples
and `deno task --no-lock build` for Deno examples.

## Example matrix

| Example | Primary purpose | Scripts/tasks | Caveats |
| --- | --- | --- | --- |
| [`advanced`](packages/advanced) | Advanced container and DI behavior | `build`, `check`, `test` | — |
| [`ai-chat`](packages/ai-chat) | AI services, tools, RAG, and workflows | `build`, `check`, `typecheck`, `test` | `typecheck` aliases `di-framework check`. Tests use fake models and need no API key; real providers require credentials. |
| [`ai-skills`](packages/ai-skills) | Agent Skills (`SKILL.md`) with `SkillsAgent.builder` | `start`, `build`, `check`, `typecheck`, `test` | Scripted tests need no API key. `bun start` and the live test use `OPENAI_API_KEY`. `Bash` is opt-in and not a container sandbox. |
| [`ai-plugins`](packages/ai-plugins) | Official `@di-framework/plugin` discovery, validation, and elective MCP wiring | `start`, `build`, `check`, `typecheck`, `test` | Depends on published `@di-framework/plugin`. Spawns its stdio MCP (`di_scaffold_provider`, docs search). No API keys required. |
| [`ai-skills-scale`](packages/ai-skills-scale) | Large-catalog Agent Skills selection and semantic retrieval experiment | `fetch`, `index`, `retrieve`, `start`, `live`, `build`, `check`, `typecheck`, `test` | Uses plain `tsc` because it has no DI decorators. `fetch` downloads a gitignored GitHub corpus; `index` uses Transformers.js locally; live trials require `OPENAI_API_KEY`. |
| [`auth`](packages/auth) | Authentication with HTTP integration | `build`, `check`, `test`, `start` | `start` runs TypeScript directly with Bun, so it does not apply emit-time transformations. |
| [`authz`](packages/authz) | Authorization policies layered on auth and HTTP | `build`, `check`, `test` | There is no `start` script; build output is emitted to `dist/`. |
| [`basic`](packages/basic) | Minimal DI usage | `build`, `check`, `test` | Depends on [`services`](packages/services) (`@di-framework/services-example`). |
| [`cf-worker`](packages/cf-worker) | Cloudflare Worker routing and Durable Objects | `build`, `check`, `test`, `dev`, `start`, `deploy`, `cf-typegen` | Requires Wrangler; deployment requires Cloudflare authentication. Depends on [`services`](packages/services). Wrangler runs from source rather than `dist/`. |
| [`config`](packages/config) | Configuration injection | `build`, `check`, `test`, `start` | `start` runs source with Bun and skips emit-time transformations. |
| [`deno-http`](packages/deno-http) | HTTP routing under Deno | Deno `build`, `dev`, and `test` tasks | Deno-only: it has no package scripts or CLI/transformer setup. `build` performs `deno check --sloppy-imports` without modifying the lockfile; runtime tasks require Deno and run with `-A`. Its TypeScript configuration is `noEmit`. |
| [`deno-sandboxes`](packages/deno-sandboxes) | Deno sandbox integration | Deno `build`, `dev`, and `test` tasks | Has the same Deno-only constraints as `deno-http`, depends on `@deno/sandbox`, and runs runtime tasks with `-A`. |
| [`docs-search`](packages/docs-search) | Cloudflare Workers AI and Vectorize documentation search | `build`, `check`, `typecheck`, `test`, `corpus`, `dev`, `deploy`, `cf-typegen` | `typecheck` aliases `check`. Local development uses remote AI and Vectorize resources. Deployment needs Cloudflare authentication, a 768-dimension Vectorize index, KV configuration, and `TOKEN_SIGNING_KEY`. |
| [`events`](packages/events) | DI-backed event publishing and listening | `build`, `check`, `test`, `start` | `start` runs source with Bun and skips emit-time transformations. |
| [`graphql`](packages/graphql) | Schema generation, bounded contexts, and GraphQL HTTP/WebSocket serving | `build`, `check`, `test`, `start`, `serve`, `sdl` | `serve` uses port 4000, and its GraphiQL UI needs network access for CDN assets. Emit relies on rewriting `.ts` import extensions. |
| [`http-router`](packages/http-router) | HTTP controller and router composition | `build`, `check`, `test` | Depends on [`services`](packages/services) (`@di-framework/services-example`). |
| [`init-tsc-inspect`](packages/init-tsc-inspect) | Reference output from `di-framework init` | `build`, `check`, `dev`, `start` | `dev` skips injected runtime checks; `build` followed by `start` exercises them. The first transformer build may compile a Go sidecar and needs a Go toolchain. |
| [`services`](packages/services) | Constructor-injected application services (`@di-framework/services-example`) | `build`, `check`, `test` | Shared by `basic`, `http-router`, and `cf-worker` as a workspace dependency. |
| [`shared`](packages/shared) | Shared example helpers (`@di-framework/examples-shared`) | `build`, `check`, `test` | Env / `.env.secrets` helpers used by `ai-skills` and `ai-skills-scale`. |
| [`test-example`](packages/test-example) | Small testing and container fixture | `build`, `check` | Despite its name, it currently has no `*.test.ts` file or `test` script. |

## Build and runtime notes

- `di-framework check` runs `ttsc --noEmit`.
- `di-framework build` emits JavaScript and applies `@di-framework/tsc`, which
  injects runtime parameter checks.
- Running `.ts` files directly with Bun does not apply emit-time transformations.
- Test files are excluded from the migrated emit configurations.
- The first `ttsc` emit may need Go to compile its sidecar.
- The aggregate [`package.json`](package.json) builds each example independently
  instead of attempting one combined TypeScript emit. Deno `build` tasks perform
  type checks because those projects are configured with `noEmit`.
