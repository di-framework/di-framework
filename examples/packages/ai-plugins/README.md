# Agent plugins example

Exercises [`@di-framework/ai-utils`](../../../packages/di-framework-ai-utils) plugin
discovery against the published [`@di-framework/plugin`](https://www.npmjs.com/package/@di-framework/plugin)
bundle, then electively starts its stdio MCP server.

The official plugin ships:

- `plugin.json` — `di-framework` manifest at the package root
- `mcp_config.json` — `di-framework-mcp` via `node ${pluginDir}/dist/index.js`
- `skills/di-framework-api/` — nested skill tree
- `rules/AGENTS.md` — framework conventions

No API keys are required. Local MCP tools such as `di_scaffold_provider` and
`di_validate_tokens` run in-process over stdio; `di_search_docs` calls the public
docs search HTTP API.

```ts
import {
  loadOfficialPluginCatalog,
  connectOfficialPluginMcp,
} from './main.ts';

const catalog = loadOfficialPluginCatalog();
const plugin = catalog.plugins[0]!;
const session = await connectOfficialPluginMcp(plugin);
console.log(session.toolNames);
await session.close();
```

## Live run

```bash
bun start
```

That validates `@di-framework/plugin`, expands `${pluginDir}` in `mcp_config.json`,
spawns the MCP server, lists tools, and calls `di_scaffold_provider`.

See the [package README](../../../packages/di-framework-ai-utils/README.md#plugins).
