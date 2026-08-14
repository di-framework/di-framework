# @di-framework/ai-utils

Agentic extras for [`@di-framework/ai`](../di-framework-ai). **Agent Skills** (`SKILL.md`, progressive disclosure) plus jailed `Read` / `Glob` and opt-in `Bash`.

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
import { skillsToolbox } from '@di-framework/ai-utils';

const agent = ChatAgent.create({
  chatModel: new OpenAiChatModel({ model: 'gpt-4o-mini' }),
  system: 'You help with code review.',
  tools: skillsToolbox({
    directories: ['.claude/skills'],
    workspace: process.cwd(),
    shell: true, // opt-in Bash; cwd is jailed, the process is not
  }),
});

await agent.chat('Review src/UserController.ts');
```

`skillsToolbox()` returns `Skill` + `Read` + `Glob`, and `Bash` when `shell: true`. Read/Bash/Glob are limited to `workspace` ∪ each skill’s folder. `Bash` is not a container — commands can still use the network or `cd` elsewhere. Prefer a container for untrusted skills.

`~/…` paths are expanded. Loaded skills must satisfy [agentskills.io](https://agentskills.io/specification) `name` and `description` rules (and the folder name must match `name`).

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

This is not Anthropic’s `AnthropicSkill` / code-execution container.

See [`examples/packages/ai-skills`](../../examples/packages/ai-skills) for a skill that loads a reference file.

## API

| Export | Role |
| --- | --- |
| `skillsToolbox` / `createSkillsToolbox` | `Skill` + `Read` + `Glob` (+ opt-in `Bash`) |
| `skillsTool` / `SkillsTool.of` / `SkillsTool.builder` | `Skill` only |
| `readTool` / `globTool` / `bashTool` | Individual jailed tools |
| `validateSkill` | agentskills.io name/description rules |
| `loadSkillsDirectory` / `loadSkillFile` | Discover `SKILL.md` |
| `parseSkillMarkdown` / `agentSkill` | Parse or construct a skill |

**Style:** `static of` / `static builder` and free functions for pure helpers. See [docs/static-methods-convention.md](../../docs/static-methods-convention.md).
