# @di-framework/ai-utils

Agentic extras for [`@di-framework/ai`](../di-framework-ai). **Agent Skills** (`SKILL.md`, progressive disclosure) plus jailed file tools, HITL, todos, optional web/memory/task, and opt-in `Write` / `Edit` / `Bash`.

This is the TypeScript counterpart of [spring-ai-agent-utils](https://github.com/spring-ai-community/spring-ai-agent-utils) — LLM-agnostic skills that run in your process, not Anthropic’s native cloud Skills API.

Skills stay in this package. `@di-framework/ai` `configureAi` / `@Agent` are unchanged; attach a toolbox or use `createSkillsAgent()`.

## Installation

```bash
bun add @di-framework/ai-utils @di-framework/ai @di-framework/core
```

Peer: `@di-framework/ai`.

## Agent Skills

A skill is a folder with a `SKILL.md` file (YAML front matter + instructions). Optional `scripts/`, `references/`, and assets stay on disk until the model asks for them.

```
.claude/skills/
└── code-reviewer/
    ├── SKILL.md
    └── references/
        └── checklist.md
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

1. Check for null pointer risks
2. Suggest a concrete fix
```

Discovery loads only `name` + `description` into the `Skill` tool description. Activation returns the full body plus the skill base directory. After activation, `allowed-tools` (if set) gates the rest of the toolbox, and file tools jail to workspace ∪ that skill folder.

```ts
import { createSkillsAgent } from '@di-framework/ai-utils';
import { OpenAiChatModel } from '@di-framework/ai';

const agent = createSkillsAgent({
  chatModel: new OpenAiChatModel({ model: 'gpt-4o-mini' }),
  directories: ['.claude/skills'],
  workspace: process.cwd(),
  write: true,
  shell: true,
  confirmShell: ({ command }) => command.startsWith('cat '),
  askUser: async (questions) => ({ [questions[0].question]: 'Day.js' }),
  web: { fetch: true },
  memories: { directory: '.memory' },
  task: true, // nested ChatAgent; uses chatModel
});

await agent.chat('Review src/UserController.ts');
```

`skillsToolbox()` (also used by `createSkillsAgent`) includes:

| Included by default | Opt-in |
| --- | --- |
| `Skill`, `Read`, `ListDirectory`, `Glob`, `Grep`, `TodoWrite` | `Write`/`Edit` (`write: true`), `Bash` (`shell: true`), `AskUserQuestion` (`askUser`), `WebFetch`/`WebSearch` (`web`), memory tools (`memories`), `Task` (`task`) |

File tools are limited to `workspace` ∪ skill folders. `Bash` jails `cwd` only and is not a container. Prefer a container for untrusted skills. Pass `confirmShell` for human approval.

When `directories` is omitted, existing `.claude/skills` (cwd) and `~/.claude/skills` are loaded. `packages` resolves npm packages (`package.json` `skills` field, else `.claude/skills` / `skills`). `directories: []` disables default dirs.

Front matter is YAML (maps, lists, scalars, `|` / `>` blocks). `allowed-tools` is parsed and enforced after Skill activation.

In-memory skills (tests, no filesystem):

```ts
import { agentSkill, skillsTool } from '@di-framework/ai-utils';

const tool = skillsTool({
  skills: [
    agentSkill({
      name: 'xlsx',
      description: 'Build spreadsheets',
      content: 'Prefer a real .xlsx over a description.',
    }),
  ],
});
```

`ChatClient.builder(model).defaultTools(...skillsToolbox(opts))` works the same way.

MCP: `skillsToolboxAsMcp(opts)` returns descriptor + handler pairs from `@di-framework/ai` `toolCallbackAsMcpTool`.

This is not Anthropic’s `AnthropicSkill` / code-execution container.

See [`examples/packages/ai-skills`](../../examples/packages/ai-skills) for a skill that loads a reference file.

## API

| Export | Role |
| --- | --- |
| `createSkillsAgent` / `createSkillsAgentBundle` | `ChatAgent` + toolbox |
| `skillsToolbox` / `createSkillsToolbox` | Full tool set |
| `skillsTool` / `SkillsTool.of` / `SkillsTool.builder` | `Skill` only |
| `skillsToolboxAsMcp` | MCP descriptors + handlers |
| File / shell tools | `readTool`, `listDirectoryTool`, `globTool`, `grepTool`, `writeTool`, `editTool`, `bashTool` |
| Agent extras | `todoWriteTool`, `askUserQuestionTool`, `webFetchTool`, `webSearchTool`, `memoryTools`, `taskTool` |
| `validateSkill` | agentskills.io name/description rules |
| `loadSkillsDirectory` / `resolveSkillPackageDirectories` | Discover `SKILL.md` |
| `parseSkillMarkdown` / `parseYaml` / `agentSkill` | Parse or construct a skill |

**Style:** `static of` / `static builder` and free functions for pure helpers. See [docs/static-methods-convention.md](../../docs/static-methods-convention.md).
