# @di-framework/ai-utils

Agentic extras for [`@di-framework/ai`](../di-framework-ai). **Agent Skills** (`SKILL.md`, progressive disclosure) plus jailed file tools, HITL questions, todos, optional web / memory / task, and opt-in `Write` / `Edit` / `Bash`.

This is the TypeScript counterpart of [spring-ai-agent-utils](https://github.com/spring-ai-community/spring-ai-agent-utils). Skills run in your process. It is not Anthropic’s hosted Skills API.

Prefer **builders**: `SkillsAgent.builder()`, `SkillsToolbox.builder()`, `SkillsTool.builder()`, `SkillsIndex.builder()`. Free-function aliases remain. Skills stay in this package — `configureAi` / `@Agent` in `@di-framework/ai` are unchanged.

## Installation

```bash
bun add @di-framework/ai-utils @di-framework/ai @di-framework/core
```

Peer: `@di-framework/ai`.

`@huggingface/transformers` is an optional peer used only by the default semantic indexer for large skill catalogs. Install it only when needed:

```bash
bun add @huggingface/transformers@4.2.0
```

## Quick start

```ts
import { OpenAiChatModel } from '@di-framework/ai';
import { SkillsAgent } from '@di-framework/ai-utils';

const agent = SkillsAgent.builder()
  .chatModel(new OpenAiChatModel({ model: 'gpt-4o-mini' }))
  .system('You help with TypeScript code review.')
  .addSkillsDirectory('.claude/skills')
  .workspace(process.cwd())
  .write()
  .shell()
  .build();

await agent.chat('Review src/UserController.ts');
```

Attach tools only:

```ts
import { ChatClient } from '@di-framework/ai';
import { SkillsToolbox } from '@di-framework/ai-utils';

const tools = SkillsToolbox.builder()
  .addSkillsDirectory('.claude/skills')
  .workspace(process.cwd())
  .buildTools();

const client = ChatClient.builder(model).defaultTools(...tools).build();
```

See [`examples/packages/ai-skills`](../../examples/packages/ai-skills) (`bun start` uses `process.env.OPENAI_API_KEY`).

## What a skill is

A skill is a folder with a `SKILL.md` (YAML front matter + instructions). Optional `scripts/`, `references/`, and other files stay on disk until the model reads them.

```
.claude/skills/
└── code-reviewer/
    ├── SKILL.md
    ├── references/
    │   └── checklist.md
    └── scripts/
        └── count-lines.sh
```

```md
---
name: code-reviewer
description: Reviews TypeScript for nulls and framework conventions. Use when the user asks to review or audit code.
license: Apache-2.0
allowed-tools:
  - Read
  - Grep
metadata:
  author: you
---

# Code Reviewer

1. Read `references/checklist.md`
2. Check for null pointer risks
3. Suggest a concrete fix
```

Discovery puts only `name` + `description` in the `Skill` tool description. Activation returns the body plus the skill base directory. After activation, `allowed-tools` (if set) gates the rest of the toolbox, and file tools jail to workspace ∪ that skill folder.

Front matter is YAML (maps, lists, scalars, `|` / `>` blocks). `name` and `description` must satisfy [agentskills.io](https://agentskills.io/specification) rules; on disk the folder name must match `name`.

## Builders

| Factory | Builds | When to use |
| --- | --- | --- |
| `SkillsAgent.builder()` | `ChatAgent` + toolbox | Usual entry |
| `SkillsToolbox.builder()` | Toolbox (`build()` / `buildTools()`) | Attach to an existing `ChatClient` / `ChatAgent` |
| `SkillsTool.builder()` | `Skill` only | Tests or when you already have Read/Glob |
| `SkillsIndex.builder()` | Build-time semantic JSONL index | Large skill catalogs |

`.of(options)` on each factory matches the older options-object APIs. Aliases: `createSkillsAgent`, `createSkillsToolbox`, `skillsToolbox`, `skillsTool`.

### Shared toolbox methods

| Method | Effect |
| --- | --- |
| `addSkillsDirectory` / `addSkillsDirectories` | Load `SKILL.md` trees |
| `addSkillsFile` | Load one `SKILL.md` |
| `addSkill` / `addSkills` | In-memory skills |
| `addPackage` / `addPackages` | npm package or path (`package.json` `skills`, else `.claude/skills` / `skills`) |
| `noDefaultDirectories` | Do not scan `.claude/skills` and `~/.claude/skills` |
| `workspace` | Default cwd / search root (also an allowed file root) |
| `extraAllowedDirectory(s)` | Extra sandbox roots |
| `write()` / `shell()` | Opt-in `Write`+`Edit` / `Bash` |
| `confirmShell(fn)` | HITL gate for `Bash` |
| `askUser(handler)` | `AskUserQuestion` |
| `web(true \| { fetch, search, braveApiKey })` | `WebFetch` / `WebSearch` |
| `memories(true \| { directory })` | Long-term memory tools (`true` → `<workspace>/.memory`) |
| `task(true \| { chatModel, system })` | Nested `Task` subagent (`true` uses `.chatModel()`) |
| `glob` / `grep` / `list` / `todos` | Pass `false` to omit (on by default) |
| `perSkillSandbox(false)` | Keep all skill dirs allowed after activate |
| `toolName` / `toolDescriptionTemplate` / `onActivate` | Customize the `Skill` tool |

### `SkillsAgent.builder()` extras

`system`, `chatModel`, `chatClient`, `extraTools`, `advisors`, `conversationMemory`, `defaultConversationId`, `defaultOptions`, `clientBuilderOptions`. `build()` returns `ChatAgent`; `buildBundle()` also returns the toolbox.

## Toolbox tools

| Included by default | Opt-in |
| --- | --- |
| `Skill`, `Read`, `ListDirectory`, `Glob`, `Grep`, `TodoWrite` | `Write` / `Edit` (`.write()`), `Bash` (`.shell()`), `AskUserQuestion` (`.askUser()`), `WebFetch` / `WebSearch` (`.web()`), `MemoryView` / `MemoryWrite` / `MemoryEdit` / `MemoryDelete` / `MemoryRename` (`.memories()`), `Task` (`.task()`) |

File tools are limited to `workspace` ∪ skill folders (and extras). After a skill with `allowed-tools` activates, other tools are denied by name.

**`Bash` jails `cwd` only.** It is not a container: the process can still use the network or `cd` elsewhere. Prefer a container for untrusted skills. Use `confirmShell` when a human should approve commands.

## Discovery

If you never call `addSkillsDirectory` / `addSkillsFile` / `addSkill` / `addPackage`, existing **`.claude/skills`** (cwd) and **`~/.claude/skills`** are loaded. Missing dirs are skipped. `noDefaultDirectories()` or an empty `directories: []` disables that.

`addPackage('@scope/pack')` resolves `pack/package.json` from the workspace, then uses the `skills` field (string or string[]) or falls back to `.claude/skills` and `skills` under the package root.

### Large catalogs

By default, every skill name and description is placed in the `Skill` tool. For catalogs above the default threshold of 50, build a local semantic index instead:

```bash
di-skills-index --skills-dir .claude/skills
```

The equivalent programmatic build API is:

```ts
import { SkillsIndex } from '@di-framework/ai-utils';

await SkillsIndex.builder()
  .addSkillsDirectory('.claude/skills')
  .build();
```

This writes `.di-framework/skills-index.jsonl`. Put the command in `prebuild` (or call the API from a build script), then enable fail-closed runtime retrieval:

```ts
const agent = SkillsAgent.builder()
  .chatModel(model)
  .addSkillsDirectory('.claude/skills')
  .semanticDiscovery()
  .build();
```

The default index is also detected automatically when present. Explicit `.semanticDiscovery()` throws if it is missing. At or below 50 skills, the build writes metadata only and keeps normal full-catalog discovery.

The default indexer uses the optional `@huggingface/transformers` peer locally. It is loaded only after the catalog exceeds the threshold; small catalogs and custom `SkillEmbedder` implementations do not require it. The indexer tokenizes each exact `SKILL.md` into 256-token chunks with 32-token overlap, embeds them with a pinned quantized BGE model, and stores compact float32/base64 vectors. Runtime scores skills from those chunks and sends only the top 10 names/descriptions to the chat model. Chunk text and vectors never enter the prompt; the chosen body still loads only after `Skill` activation.

Configure `.threshold()`, `.chunkTokens()`, `.chunkOverlapTokens()`, `.retrievalLimit()`, or `.embedder()` on `SkillsIndex.builder()` when the defaults do not fit the corpus. The `buildSkillsIndex(options)` free-function alias remains available. Runtime `.semanticDiscovery({ limit, minScore, embedder })` can override candidate count and query embedding.

## Skill-only and MCP

```ts
import { agentSkill, SkillsTool, skillsToolboxAsMcp } from '@di-framework/ai-utils';

const skillOnly = SkillsTool.builder()
  .addSkill(
    agentSkill({
      name: 'xlsx',
      description: 'Build spreadsheets when asked for a spreadsheet.',
      content: 'Prefer a real .xlsx over a description.',
    }),
  )
  .build();

const mcp = skillsToolboxAsMcp({
  directories: ['.claude/skills'],
  workspace: process.cwd(),
});
```

`skillsToolboxAsMcp` returns `{ descriptor, handler, returnDirect }[]` from `@di-framework/ai` `toolCallbackAsMcpTool`.

## Safety

- Path jail rejects raw `..`, sibling prefix matches, and escaping symlinks.
- `Write` / `Edit` / `Bash` are off until you enable them.
- `allowed-tools` is enforced only after `Skill` runs.
- `WebSearch` needs `BRAVE_API_KEY` or `.web({ braveApiKey })`.
- `Task` subagents do not get `AskUserQuestion` or nested `Task`.

## API

| Export | Role |
| --- | --- |
| `SkillsAgent` / `SkillsAgentBuilder` | Preferred agent factory |
| `SkillsToolbox` / `SkillsToolboxBuilder` | Preferred toolbox factory |
| `SkillsTool` / `SkillsToolBuilder` | `Skill` only |
| `SkillsIndex` / `SkillsIndexBuilder` | Build-time semantic skill index |
| `skillsToolboxAsMcp` | MCP descriptors + handlers |
| File / shell | `readTool`, `listDirectoryTool`, `globTool`, `grepTool`, `writeTool`, `editTool`, `bashTool` |
| Agent extras | `todoWriteTool`, `askUserQuestionTool`, `webFetchTool`, `webSearchTool`, `memoryTools`, `taskTool` |
| Discovery | `loadSkillsDirectory`, `resolveSkillPackageDirectories`, `existingSkillDirectories`, `SkillsIndex.builder()`, `searchSkillsIndex`, `di-skills-index` CLI |
| Parse / validate | `parseSkillMarkdown`, `parseYaml`, `agentSkill`, `validateSkill` |

**Style:** `static of` / `static builder` and free functions for pure helpers. See [docs/static-methods-convention.md](../../docs/static-methods-convention.md).
