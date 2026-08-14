# Agent Skills example

[`@di-framework/ai-utils`](../../../packages/di-framework-ai-utils) `SkillsAgent.builder()` / `SkillsToolbox.builder()` attached to a `ChatAgent`.

The bundled skill is `.claude/skills/code-reviewer/`:

- `SKILL.md` — when to review code
- `references/checklist.md` — loaded with `Read` after the skill activates
- `scripts/count-lines.sh` — optional `Bash` (`.shell()`)

`fixtures/sample-user.ts` is the live review target (intentional null / undefined access).

`Write` / `Edit` / `Bash` are **opt-in**. `ListDirectory` and `TodoWrite` are on by default. `Bash` is not a container sandbox — the process can still reach the network or other paths. Prefer a container for untrusted skills.

```ts
import { OpenAiChatModel } from '@di-framework/ai';
import { SkillsAgent } from '@di-framework/ai-utils';

const agent = SkillsAgent.builder()
  .chatModel(new OpenAiChatModel({ model: 'gpt-4o-mini', apiKey: process.env.OPENAI_API_KEY }))
  .addSkillsDirectory('.claude/skills')
  .workspace(process.cwd())
  .build();
```

## Live run

`OpenAiChatModel` reads `process.env.OPENAI_API_KEY` when `apiKey` is omitted. The example passes it explicitly. If the process env is empty, `bun start` also loads a gitignored `.env.secrets` from this package or a parent directory (repo root).

```bash
bun start
```

That reviews `fixtures/sample-user.ts` with the `code-reviewer` skill (`Skill` → `Read` checklist/source, optional `Bash` for `count-lines.sh`).

Scripted tests do not need an API key. The live OpenAI test runs only when `OPENAI_API_KEY` is set.

See the [package README](../../../packages/di-framework-ai-utils/README.md) and [Writerside topic](../../../docs/Writerside/topics/ai-utils.md).
