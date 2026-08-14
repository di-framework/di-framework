# Agent Skills example

[`@di-framework/ai-utils`](../../../packages/di-framework-ai-utils) `SkillsAgent.builder()` / `SkillsToolbox.builder()` attached to a `ChatAgent`.

The bundled skill is `.claude/skills/code-reviewer/`:

- `SKILL.md` — when to review code
- `references/checklist.md` — loaded with `Read` after the skill activates
- `scripts/count-lines.sh` — optional `Bash` (`.shell()`)

`Write` / `Edit` / `Bash` are **opt-in**. `ListDirectory` and `TodoWrite` are on by default. `Bash` is not a container sandbox — the process can still reach the network or other paths. Prefer a container for untrusted skills.

```ts
import { SkillsAgent } from '@di-framework/ai-utils';

const agent = SkillsAgent.builder()
  .chatModel(model)
  .addSkillsDirectory('.claude/skills')
  .workspace(process.cwd())
  .build();
```

Tests use `ScriptedChatModel` and do not need an API key.

See the [package README](../../../packages/di-framework-ai-utils/README.md) and [Writerside topic](../../../docs/Writerside/topics/ai-utils.md).
