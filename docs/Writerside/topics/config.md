# Configuration

Load, validate, and inject application configuration through the DI container. Domain services stay on `@di-framework/core`; this package is the typed config layer.

## Features

- **Sources**: `envSource`, `objectSource`, `jsonFileSource` (deep-merged left → right).
- **Validation**: pluggable `ConfigSchema` — optional Zod adapter at `@di-framework/config/zod`.
- **DI registration**: `registerConfig` exposes the root object plus flattened dotted paths.
- **Decorators**: `@Configuration` / `@Value` match the rest of the framework.
- **Imperative API**: `loadConfig` / `loadAndRegisterConfig` for scripts and tests.

## Installation

```bash
bun add @di-framework/config @di-framework/core
# optional validation
bun add zod   # for @di-framework/config/zod
```

```bash
npm install @di-framework/config @di-framework/core
```

Decorators need TypeScript 5 and `experimentalDecorators`. `emitDecoratorMetadata` is not required.

## Quick Start

```typescript
import { Container } from '@di-framework/core/decorators';
import { useContainer } from '@di-framework/core/container';
import {
  Configuration,
  Value,
  envSource,
} from '@di-framework/config';

@Configuration({
  sources: [envSource({ prefix: 'APP_' })],
})
class AppConfig {
  host = 'localhost';
  port = 3000;
  database = { host: 'localhost', port: 5432 };
}

@Container()
class DatabaseService {
  @Value('database.host')
  host!: string;

  constructor(@Value('port') public port: number) {}
}

const db = useContainer().resolve(DatabaseService);
```

With `APP_PORT=8080` and `APP_DATABASE__HOST=db.internal`, `db.port` is `8080` and `db.host` is `db.internal`.

`@Configuration` builds defaults from class property initializers, merges sources, registers the result under the `'config'` token (with flattened paths), and registers the class as a singleton holding the loaded snapshot.

## Imperative API

Prefer this when sources are async or you want explicit control in bootstrap code:

```typescript
import {
  loadAndRegisterConfig,
  envSource,
  objectSource,
  jsonFileSource,
} from '@di-framework/config';
import { useContainer } from '@di-framework/core/container';

const config = await loadAndRegisterConfig({
  defaults: { port: 3000 },
  sources: [
    jsonFileSource('./config.json', { optional: true }),
    envSource({ prefix: 'APP_' }),
    objectSource({ /* test overrides */ }),
  ],
  token: 'config', // default
  flatten: true,   // default — registers config.port, config.db.host, …
});

useContainer().resolve<number>('config.port');
```

Sync variants: `loadConfigSync` / `loadAndRegisterConfigSync` (all sources must return plain objects, not Promises).

## Zod Validation

```typescript
import { z } from 'zod';
import { loadConfigSync, objectSource } from '@di-framework/config';
import { zodSchema } from '@di-framework/config/zod';

const schema = zodSchema(
  z.object({
    port: z.coerce.number().default(3000),
    apiKey: z.string().min(1),
  }),
);

const config = loadConfigSync({
  sources: [objectSource({ apiKey: 'k', port: '4000' })],
  schema,
});
```

Any object with a `parse(input)` method can implement `ConfigSchema`. Use `schemaFromParse` to wrap a plain function.

## Env Mapping

| Option | Default | Meaning |
| --- | --- | --- |
| `prefix` | `''` | Only keys with this prefix; prefix is stripped |
| `separator` | `'__'` | Nesting delimiter after strip |
| `keyCase` | `'camel'` | Segment transform (`DATABASE_HOST` → `databaseHost`) |
| `coerce` | `true` | Parse booleans, numbers, JSON literals |

`APP_DB__HOST=localhost` → `{ db: { host: 'localhost' } }`.

## Injecting Values

With `flatten: true` (the default), every dotted path is a DI token. `@Value('database.host')` is equivalent to `@Component('config.database.host')`.

```typescript
@Container()
class ApiClient {
  constructor(
    @Value('apiKey') private apiKey: string,
    @Component('config') private config: AppConfig,
  ) {}
}
```

## API Reference

| Export | Description |
| --- | --- |
| `loadConfig` / `loadConfigSync` | Merge defaults + sources (+ schema) |
| `registerConfig` | Put config (and paths) on the container |
| `loadAndRegisterConfig` / `loadAndRegisterConfigSync` | Load then register |
| `envSource` / `objectSource` / `jsonFileSource` | Built-in sources |
| `Configuration` / `Value` | Decorators |
| `schemaFromParse` / `identitySchema` | Schema helpers |
| `@di-framework/config/zod` | `zodSchema` |

## Non-goals (v1)

YAML/TOML loaders, remote config providers, live reload / watch, and secret managers. Implement `ConfigSource` / `ConfigSchema` for those.

## Example

A worked example lives in the [config example package](https://github.com/di-framework/di-framework/tree/main/examples/packages/config).
