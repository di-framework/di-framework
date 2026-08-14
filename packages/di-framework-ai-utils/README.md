# @di-framework/ai-utils

Agentic extras for [`@di-framework/ai`](../di-framework-ai). First cut: **Agent Skills** (`SKILL.md`, progressive disclosure) as a `ToolCallback` you attach to `ChatAgent` / `ChatClient`.

This is the TypeScript counterpart of [spring-ai-agent-utils](https://github.com/spring-ai-community/spring-ai-agent-utils) `SkillsTool` — LLM-agnostic skills that run in your process, not Anthropic’s native cloud Skills API.

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
---

# Code Reviewer

1. Check for null pointer risks
2. Suggest a concrete fix
```

Discovery loads only `name` + `description` into the `Skill` tool description. Activation returns the full body plus the skill base directory.

```ts
import { ChatAgent, OpenAiChatModel } from '@di-framework/ai';
import { SkillsTool } from '@di-framework/ai-utils';

const agent = ChatAgent.create({
  chatModel: new OpenAiChatModel({ model: 'gpt-4o-mini' }),
  system: 'You help with code review.',
  tools: [SkillsTool.builder().addSkillsDirectory('.claude/skills').build()],
});

await agent.chat('Review src/UserController.ts');
```

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

`ChatClient.builder(model).defaultTools(tool)` works the same way — `ChatAgent` is just the usual wrapper.

**Not included (yet):** a sandboxed `Read` / `Bash` pair. `SKILL.md` can be self-contained; extra files and scripts need your own tools (or a later utils release). Scripts you do run execute on the host.

This is not Anthropic’s `AnthropicSkill` / code-execution container. Use that provider surface when you want Claude’s hosted document skills.

## API

| Export | Role |
| --- | --- |
| `skillsTool` / `SkillsTool.of` / `SkillsTool.builder` | `Skill` `ToolCallback` |
| `loadSkillsDirectory` / `loadSkillFile` | Discover `SKILL.md` |
| `parseSkillMarkdown` / `agentSkill` | Parse or construct a skill |

**Style:** `static of` / `static builder` and free functions for pure helpers. See [docs/static-methods-convention.md](../../docs/static-methods-convention.md).
