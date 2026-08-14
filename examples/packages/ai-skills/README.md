# Agent Skills example

`@di-framework/ai-utils` `skillsToolbox()` attached to a `ChatAgent`.

The bundled skill is `.claude/skills/code-reviewer/`:

- `SKILL.md` — when to review code
- `references/checklist.md` — loaded with `Read` after the skill activates
- `scripts/count-lines.sh` — optional `Bash` (`shell: true`)

`Bash` is **opt-in** and is not a container sandbox. The process can still reach the network or other paths. Prefer a container for untrusted skills.

Tests use `ScriptedChatModel` and do not need an API key.
