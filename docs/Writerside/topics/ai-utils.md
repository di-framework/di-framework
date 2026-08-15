# Agent Skills (`@di-framework/ai-utils`)

Agentic extras for [`@di-framework/ai`](ai.md). **Agent Skills** (`SKILL.md`, progressive disclosure) plus jailed file tools, HITL questions, todos, optional web / memory / task, and opt-in `Write` / `Edit` / `Bash`.

This is the TypeScript counterpart of [spring-ai-agent-utils](https://github.com/spring-ai-community/spring-ai-agent-utils). Skills run in your process. It is not Anthropic’s hosted Skills API.

Prefer **builders**: `SkillsAgent.builder()`, `SkillsToolbox.builder()`, `SkillsTool.builder()`. Free-function aliases remain. Skills stay in this package — `configureAi` / `@Agent` on [AI](ai.md) are unchanged.

## Features

- **Progressive disclosure**: discovery embeds `name` + `description`; activation loads the full `SKILL.md` body and base directory.
- **Builder-first**: `SkillsAgent.builder()` for a `ChatAgent`, `SkillsToolbox.builder()` to attach tools, `SkillsTool.builder()` for `Skill` only.
- **YAML front matter**: maps, lists, scalars, `|` / `>` blocks; `allowed-tools`, `license`, `compatibility`, `metadata`.
- **Jailed file tools**: `Read`, `ListDirectory`, `Glob`, `Grep`, opt-in `Write` / `Edit` / `Bash`.
- **Agent extras**: `TodoWrite`, optional `AskUserQuestion`, web fetch/search, file memory, nested `Task`.
- **Enforcement**: after a skill with `allowed-tools` activates, other tools are gated; file tools jail to workspace ∪ that skill.
- **Discovery**: directories, single files, in-memory skills, npm packages, or default `.claude/skills` and `~/.claude/skills`.

## Installation

```bash
bun add @di-framework/ai-utils @di-framework/ai @di-framework/core
```

```bash
npm install @di-framework/ai-utils @di-framework/ai @di-framework/core
```

Peer: `@di-framework/ai`.

## Quick start

```typescript
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

Attach the toolbox to an existing client:

```typescript
import { ChatClient } from '@di-framework/ai';
import { SkillsToolbox } from '@di-framework/ai-utils';

const tools = SkillsToolbox.builder()
  .addSkillsDirectory('.claude/skills')
  .workspace(process.cwd())
  .buildTools();

const client = ChatClient.builder(model).defaultTools(...tools).build();
```

The [`ai-skills`](https://github.com/di-framework/di-framework/tree/main/examples/packages/ai-skills) example has scripted tests (no API key) and a live `bun start` path that reviews `fixtures/sample-user.ts` with `OpenAiChatModel` (`process.env.OPENAI_API_KEY`).

## Skill folders

A skill is a folder with a `SKILL.md` file (YAML front matter + instructions). Optional `scripts/`, `references/`, and other files stay on disk until the model reads them.

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

`name` and `description` must satisfy [agentskills.io](https://agentskills.io/specification) rules. On disk, the folder name must match `name`. Invalid loaded skills fail closed.

## Builders

| Factory | Builds | When to use |
| --- | --- | --- |
| `SkillsAgent.builder()` | `ChatAgent` + toolbox | Usual entry |
| `SkillsToolbox.builder()` | Toolbox (`build()` / `buildTools()`) | Existing `ChatClient` / `ChatAgent` |
| `SkillsTool.builder()` | `Skill` only | Tests, or when you already have file tools |

`.of(options)` matches the older options-object APIs. Aliases: `createSkillsAgent`, `createSkillsToolbox`, `skillsToolbox`, `skillsTool`.

### Shared toolbox methods

These exist on both `SkillsAgent.builder()` and `SkillsToolbox.builder()`.

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
| `confirmShell(fn)` | Approve or reject each `Bash` command |
| `askUser(handler)` | `AskUserQuestion` |
| `web(true \| { fetch, search, braveApiKey })` | `WebFetch` / `WebSearch` |
| `memories(true \| { directory })` | Long-term memory tools (`true` → `<workspace>/.memory`) |
| `task(true \| { chatModel, system })` | Nested `Task` (`true` uses `.chatModel()`) |
| `glob` / `grep` / `list` / `todos` | Pass `false` to omit (on by default) |
| `perSkillSandbox(false)` | Keep all skill dirs allowed after activate |
| `toolName` / `toolDescriptionTemplate` / `onActivate` | Customize the `Skill` tool |

### Agent-only methods

`system`, `chatModel`, `chatClient`, `extraTools`, `advisors`, `conversationMemory`, `defaultConversationId`, `defaultOptions`, `clientBuilderOptions`.

`build()` returns `ChatAgent`. `buildBundle()` returns `{ agent, toolbox }`.

## Tools

| Included by default | Opt-in |
| --- | --- |
| `Skill`, `Read`, `ListDirectory`, `Glob`, `Grep`, `TodoWrite` | `Write` / `Edit` (`.write()`), `Bash` (`.shell()`), `AskUserQuestion` (`.askUser()`), `WebFetch` / `WebSearch` (`.web()`), memory tools (`.memories()`), `Task` (`.task()`) |

File tools are limited to `workspace` ∪ skill folders (and extras). After a skill with `allowed-tools` activates, other tools are denied by name.

**`Bash` jails `cwd` only.** It is not a container: the process can still use the network or `cd` elsewhere. Prefer a container for untrusted skills. Use `confirmShell` when a human should approve commands.

`WebSearch` needs `BRAVE_API_KEY` or `.web({ braveApiKey })`. `Task` subagents do not get `AskUserQuestion` or nested `Task`.

## Discovery

If you never add directories, files, in-memory skills, or packages, existing **`.claude/skills`** (cwd) and **`~/.claude/skills`** are loaded. Missing dirs are skipped. `noDefaultDirectories()` disables that.

`addPackage('@scope/pack')` resolves the package from the workspace, then uses `package.json` `skills` or falls back to `.claude/skills` and `skills` under the package root.

### Large catalogs

Normal discovery places every skill name and description in the `Skill` tool. For catalogs above the default threshold of 50, generate a semantic index during the application build:

```bash
di-skills-index --skills-dir .claude/skills
```

Or call the same package implementation programmatically:

```typescript
import { SkillsIndex } from '@di-framework/ai-utils';

await SkillsIndex.builder()
  .addSkillsDirectory('.claude/skills')
  .build();
```

This writes `.di-framework/skills-index.jsonl`. Enable fail-closed retrieval with `.semanticDiscovery()` on `SkillsAgent.builder()` or `SkillsToolbox.builder()`. The default index is also detected automatically when present.

The default indexer uses the optional `@huggingface/transformers` peer. Install it only for large-catalog indexing (`bun add @huggingface/transformers@4.2.0`); small catalogs and custom embedders do not need it. Transformers.js tokenizes each exact `SKILL.md` into overlapping model-token chunks and embeds them locally with a pinned quantized BGE model. Runtime ranks skills using chunk cosine scores and sends only the top 10 names/descriptions to the chat model. Chunks and vectors do not enter the prompt; the full body remains lazy until activation. At or below the threshold, Transformers.js is not initialized and normal discovery remains active.

## Skill-only and MCP

```typescript
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

`skillsToolboxAsMcp` returns descriptor + handler pairs from `@di-framework/ai` `toolCallbackAsMcpTool`.

## Related

- [AI](ai.md) — chat, tools, RAG, MCP, and agents (`@di-framework/ai`)
- [Package README](https://github.com/di-framework/di-framework/blob/main/packages/di-framework-ai-utils/README.md)
- [Example](https://github.com/di-framework/di-framework/tree/main/examples/packages/ai-skills)
