/**
 * `@di-framework/ai-utils` — agentic extras for `@di-framework/ai`.
 *
 * Agent Skills (SKILL.md / progressive disclosure) live here so the core AI
 * package stays model/tools/RAG/MCP focused, matching Spring's split of
 * spring-ai vs spring-ai-agent-utils.
 */

export type {
  AgentSkill,
  AgentSkillCreateOptions,
  ParseSkillMarkdownOptions,
  SkillsInput,
  SkillsToolOptions,
} from './skills/index.ts';
export {
  agentSkill,
  collectSkills,
  DEFAULT_SKILL_TOOL_NAME,
  formatSkillLoadResult,
  formatSkillNotFound,
  loadSkillFile,
  loadSkillsDirectories,
  loadSkillsDirectory,
  parseSkillMarkdown,
  SkillsTool,
  SkillsToolBuilder,
  skillsTool,
  skillToXml,
} from './skills/index.ts';
