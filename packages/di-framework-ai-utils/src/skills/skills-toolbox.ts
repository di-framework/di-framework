import type { ToolCallback } from '@di-framework/ai';
import { expandUserPath, uniqueResolvedRoots } from '../sandbox/paths.ts';
import { bashTool } from '../tools/bash-tool.ts';
import { globTool } from '../tools/glob-tool.ts';
import { readTool } from '../tools/read-tool.ts';
import type { AgentSkill } from './parse-skill-markdown.ts';
import type { SkillsToolOptions } from './skills-tool.ts';
import { collectSkills, skillsTool } from './skills-tool.ts';
import { validateSkill } from './validate-skill.ts';

export interface SkillsToolboxOptions extends SkillsToolOptions {
  /** Workspace root used as the default Read/Bash/Glob directory. */
  readonly workspace?: string;
  /** Extra allowed roots besides workspace + skill base paths. */
  readonly extraAllowedDirectories?: readonly string[];
  /** When true, include the opt-in {@code Bash} tool. Default false. */
  readonly shell?: boolean;
  readonly shellTimeoutMs?: number;
  /** When false, omit {@code Glob}. Default true. */
  readonly glob?: boolean;
}

export interface SkillsToolbox {
  readonly skills: readonly AgentSkill[];
  readonly allowedDirectories: readonly string[];
  readonly tools: readonly ToolCallback[];
}

/**
 * Skill + Read + Glob, and optional Bash, jailed to workspace ∪ skill dirs.
 */
export function skillsToolbox(options: SkillsToolboxOptions): ToolCallback[] {
  return createSkillsToolbox(options).tools as ToolCallback[];
}

export function createSkillsToolbox(options: SkillsToolboxOptions): SkillsToolbox {
  const directories = (options.directories ?? []).map(expandUserPath);
  const files = (options.files ?? []).map(expandUserPath);
  const collected = collectSkills({
    ...options,
    directories,
    files,
  });

  for (const skill of collected) {
    const fromDisk = skill.basePath !== '.' && (directories.length > 0 || files.length > 0);
    validateSkill(skill, { matchDirectoryName: fromDisk });
  }

  const workspace = options.workspace ? expandUserPath(options.workspace) : process.cwd();
  const allowedDirectories = uniqueResolvedRoots([
    workspace,
    ...collected.map((skill) => skill.basePath),
    ...(options.extraAllowedDirectories ?? []),
  ]);

  const tools: ToolCallback[] = [
    skillsTool({
      ...options,
      skills: collected,
      directories: undefined,
      files: undefined,
    }),
    readTool({ allowedDirectories }),
  ];

  if (options.glob !== false) {
    tools.push(globTool({ allowedDirectories, workingDirectory: workspace }));
  }
  if (options.shell) {
    tools.push(
      bashTool({
        allowedDirectories,
        workingDirectory: workspace,
        timeoutMs: options.shellTimeoutMs,
      }),
    );
  }

  return { skills: collected, allowedDirectories, tools };
}
