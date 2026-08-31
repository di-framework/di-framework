# @di-framework/config

Load, validate, and inject application configuration through the DI container. Domain services stay on `@di-framework/core`; this package is the typed config layer.

## Features

- **Sources**: `envSource`, `objectSource`, `jsonFileSource`, `yamlFileSource`, `tomlFileSource` (deep-merged left → right).
- **Profiles**: `@WithProfile` overlays `{profile}.config.{ext}` next to the base file.
- **Validation**: pluggable `ConfigSchema` — optional Zod adapter at `@di-framework/config/zod`.
- **DI registration**: `registerConfig` exposes the root object plus flattened dotted paths.
- **Decorators**: `@Configuration` / `@Value` / `@WithProfile` match the rest of the framework.
- **Imperative API**: `loadConfig` / `loadAndRegisterConfig` for scripts and tests.

## Installation

```bash
bun add @di-framework/config @di-framework/core
# optional validation / file formats
bun add zod        # for @di-framework/config/zod
bun add yaml       # for yamlFileSource
bun add smol-toml  # for tomlFileSource
```

## Quick start

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

## Imperative API

```typescript
import {
  loadAndRegisterConfig,
  envSource,
  objectSource,
  jsonFileSource,
  yamlFileSource,
  tomlFileSource,
} from '@di-framework/config';
import { useContainer } from '@di-framework/core/container';

const config = await loadAndRegisterConfig({
  defaults: { port: 3000 },
  sources: [
    yamlFileSource('./config.yaml', { optional: true }),
    tomlFileSource('./config.toml', { optional: true }),
    jsonFileSource('./config.json', { optional: true }),
    envSource({ prefix: 'APP_' }),
    objectSource({ /* test overrides */ }),
  ],
  token: 'config', // default
  flatten: true,   // default — registers config.port, config.db.host, …
});

useContainer().resolve('config.port'); // number
```

## Zod

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

## Env mapping

| Option | Default | Meaning |
| --- | --- | --- |
| `prefix` | `''` | Only keys with this prefix; prefix is stripped |
| `separator` | `'__'` | Nesting delimiter after strip |
| `keyCase` | `'camel'` | Segment transform (`DATABASE_HOST` → `databaseHost`) |
| `coerce` | `true` | Parse booleans, numbers, JSON literals |

`APP_DB__HOST=localhost` → `{ db: { host: 'localhost' } }`.

## API

| Export | |
| --- | --- |
| `loadConfig` / `loadConfigSync` | Merge defaults + sources (+ schema + profiles) |
| `registerConfig` | Put config (and paths) on the container |
| `loadAndRegisterConfig` | Both of the above |
| `envSource` / `objectSource` / `jsonFileSource` / `yamlFileSource` / `tomlFileSource` | Built-in sources |
| `Configuration` / `Value` / `WithProfile` | Decorators |
| `setSelectedProfiles` / `getSelectedProfiles` | Process-wide selected profiles |
| `profileConfigPath` | Resolve `{profile}.config.{ext}` next to a base file |
| `schemaFromParse` / `identitySchema` | Schema helpers |
| `@di-framework/config/zod` | `zodSchema` |
| `@di-framework/config/yaml` | `yamlFileSource` (optional peer `yaml`) |
| `@di-framework/config/toml` | `tomlFileSource` (optional peer `smol-toml`) |

## File sources

JSON parsing is built in. YAML needs the optional peer `yaml`; TOML needs `smol-toml`. Importing `@di-framework/config` does not load those parsers until `yamlFileSource` / `tomlFileSource` actually `load()`. Dedicated subpaths `@di-framework/config/yaml` and `@di-framework/config/toml` export the same functions.

All three file sources:

- Require a plain-object root (arrays, primitives, and `null` throw).
- Use `optional: true` so a missing **base** file (`ENOENT`) yields `{}`. Invalid syntax still throws.
- Label errors as `json:`, `yaml:`, or `toml:` plus the path.
- Do not support multi-document YAML streams.

## Profiles

When a profile is selected, each file source loads the base file, then deep-merges `{profile}.config.{ext}` from the **same directory**. The overlay name is always `{profile}.config.{ext}` — it does not depend on the base file stem.

| Base file | Selected profile | Overlay |
| --- | --- | --- |
| `./config.yaml` | `dev` | `./dev.config.yaml` |
| `./config.toml` | `prod` | `./prod.config.toml` |
| `./settings.json` | `qa` | `./qa.config.json` |

Select profiles with, in order of precedence for a given source:

1. `yamlFileSource(path, { profiles: ['dev'] })` (and the JSON/TOML equivalents)
2. `@WithProfile('dev')` on the `@Configuration` class, or `loadConfig({ profiles: ['dev'] })`
3. `setSelectedProfiles('dev')`

```typescript
import { Configuration, WithProfile, yamlFileSource } from '@di-framework/config';

@WithProfile('dev')
@Configuration({
  sources: [yamlFileSource('./config.yaml')],
})
class AppConfig {
  host = 'localhost';
}
```

Several profiles merge left → right (`@WithProfile('dev', 'local')` applies `dev.config.yaml` then `local.config.yaml`). Missing overlay files are skipped; invalid names (`..`, path separators, empty) throw. `optional` on the source applies only to the base file.

## Non-goals (v1)

Remote config providers, live reload / watch, and secret managers. Implement `ConfigSource` / `ConfigSchema` for those.

## License

Licensed under either [MIT](../../LICENSE-MIT) or [Apache-2.0](../../LICENSE-APACHE), at your option.
