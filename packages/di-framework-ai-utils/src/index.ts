/**
 * `@di-framework/ai-utils` — agentic extras for `@di-framework/ai`.
 *
 * Agent Skills (SKILL.md / progressive disclosure) live here so the core AI
 * package stays model/tools/RAG/MCP focused, matching Spring's split of
 * spring-ai vs spring-ai-agent-utils.
 */

export type { PathAccessDenied, PathAccessOk, PathAccessResult } from './sandbox/index.ts';
export { assertPathAllowed, expandUserPath, uniqueResolvedRoots } from './sandbox/index.ts';
export type {
  AgentSkill,
  AgentSkillCreateOptions,
  ParseSkillMarkdownOptions,
  SkillsInput,
  SkillsToolbox,
  SkillsToolboxOptions,
  SkillsToolOptions,
  ValidateSkillOptions,
} from './skills/index.ts';
export {
  agentSkill,
  collectSkills,
  createSkillsToolbox,
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
  skillsToolbox,
  skillToXml,
  validateSkill,
  validateSkillDescription,
  validateSkillName,
} from './skills/index.ts';
export type {
  BashInput,
  BashToolOptions,
  GlobInput,
  GlobToolOptions,
  ReadInput,
  ReadToolOptions,
} from './tools/index.ts';
export {
  bashTool,
  DEFAULT_BASH_TIMEOUT_MS,
  DEFAULT_MAX_LINE_CHARS,
  DEFAULT_READ_LIMIT,
  globTool,
  MAX_BASH_TIMEOUT_MS,
  readTool,
} from './tools/index.ts';
