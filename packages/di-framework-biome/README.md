# @di-framework/biome

Biome GritQL plugins for applications written with di-framework. The rules match source patterns that fail at startup, load the wrong package, or put secrets in a guest binding.

## Install

```bash
bun add -d @biomejs/biome @di-framework/biome
```

`biome.json`:

```json
{
  "extends": ["@di-framework/biome"],
  "javascript": {
    "parser": {
      "unsafeParameterDecoratorsEnabled": true
    }
  }
}
```

`unsafeParameterDecoratorsEnabled` lets Biome parse `@Component` on constructor parameters. Plugin paths are resolved from the application root, so the package must be installed in `node_modules`.

`@di-framework/biome` enables every rule. `@di-framework/biome/correctness` is the same set without the 5.x package renames (`no-wasmcloud-package`, `no-cli-plugin-wasmcloud`) and the deprecated `@di-framework/socket/bun` alias.

```bash
biome check .
```

Suppress a single finding with `// biome-ignore lint/plugin/<rule-file-name>: reason`.

## Rules

| Rule | Catches |
| --- | --- |
| `no-bootstrap-decorator` | `@Bootstrap()` |
| `no-reflect-metadata` | `import 'reflect-metadata'` |
| `no-wasmcloud-package` | `@di-framework/wasmcloud` |
| `no-cli-plugin-wasmcloud` | `@di-framework/cli-plugin-wasmcloud` |
| `no-socket-bun-alias` | `@di-framework/socket/bun` |
| `no-actors-testing-import` | `@di-framework/actors/testing` outside `*.test.ts` and `tests/` |
| `use-scoped-core-import` | unscoped `di-framework/...` imports |
| `use-configuration-import` | `Bean` from config, or `Value` / `WithProfile` from core |
| `no-bean-outside-configuration` | `@Bean` without core `@Configuration()` |
| `use-bean-dependencies` | `@Bean` factory parameters without `dependencies` |
| `no-inject-outside-container` | `@Component`, `@Value`, or `@ServiceBinding` on a class that is not container-managed |
| `no-bad-cron-expression` | 6-field cron strings and names such as `@daily` |
| `no-generated-value-without-id` | `@GeneratedValue` without `@Id` |
| `no-plaintext-binding-secret` | secret-like keys in `@WasmCloudBinding` `config` |
| `use-wit-binding-name` | binding names that are not WIT identifiers |
| `no-service-name-on-non-postgres` | `serviceName` on a class that does not extend `Postgres` |
| `no-short-auth-secret` | `registerAuth({ secret })` literals shorter than 32 characters |
| `no-emit-decorator-metadata` | `emitDecoratorMetadata: true` |
| `use-experimental-decorators` | `experimentalDecorators: false` |

These plugins are syntactic. Missing registrations, cycles, and bounded-context edges still belong to `ApplicationContext.start()` and `buildSemanticSchema()`.
