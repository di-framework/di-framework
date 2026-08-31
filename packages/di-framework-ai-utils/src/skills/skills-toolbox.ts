import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { ChatModel, ToolCallback } from '@di-framework/ai';
import { expandUserPath, uniqueResolvedRoots } from '../sandbox/paths.ts';
import { askUserQuestionTool, type QuestionHandler } from '../tools/ask-user-question-tool.ts';
import { type BashConfirmInput, bashTool } from '../tools/bash-tool.ts';
import { editTool } from '../tools/edit-tool.ts';
import { gateToolCallback } from '../tools/gate-tool.ts';
import { globTool } from '../tools/glob-tool.ts';
import { grepTool } from '../tools/grep-tool.ts';
import { listDirectoryTool } from '../tools/list-directory-tool.ts';
import { memoryTools } from '../tools/memory-tools.ts';
import { readTool } from '../tools/read-tool.ts';
import { taskTool } from '../tools/task-tool.ts';
import { todoWriteTool } from '../tools/todo-write-tool.ts';
import { webFetchTool } from '../tools/web-fetch-tool.ts';
import { webSearchTool } from '../tools/web-search-tool.ts';
import { writeTool } from '../tools/write-tool.ts';
import { existingSkillDirectories } from './load-skills.ts';
import type { AgentSkill } from './parse-skill-markdown.ts';
import { resolveSkillPackageDirectories } from './resolve-packages.ts';
import type { SkillCatalogStore, SkillVectorSearch } from './skill-adapters.ts';
import type { SkillEmbedder } from './skill-embedder.ts';
import { SkillsFluent } from './skills-fluent.ts';
import { DEFAULT_SKILLS_INDEX_FILE, loadSkillsIndex } from './skills-index.ts';
import { SkillsRetrievalAdvisor } from './skills-retrieval-advisor.ts';
import { createSkillsRuntime, type SkillsRuntime } from './skills-runtime.ts';
import type { SkillsToolOptions } from './skills-tool.ts';
import { collectSkills, DEFAULT_SKILL_TOOL_NAME, skillsTool } from './skills-tool.ts';
import { validateSkill } from './validate-skill.ts';

export interface SkillsToolboxWebOptions {
  readonly fetch?: boolean;
  readonly search?: boolean;
  readonly braveApiKey?: string;
}

export interface SkillsToolboxMemoriesOptions {
  readonly directory: string;
}

export interface SkillsToolboxTaskOptions {
  readonly chatModel: ChatModel;
  readonly system?: string;
}

export interface SkillsSemanticDiscoveryOptions {
  /** Generated JSONL path. Relative paths resolve from {@link workspace}. */
  readonly indexFile?: string;
  readonly limit?: number;
  readonly minScore?: number;
  readonly recentUserMessages?: number;
  readonly embedder?: SkillEmbedder;
  readonly catalogStore?: SkillCatalogStore;
  readonly vectorSearch?: SkillVectorSearch;
  readonly namespace?: string;
}

export interface SkillsToolboxOptions extends SkillsToolOptions {
  readonly workspace?: string;
  readonly extraAllowedDirectories?: readonly string[];
  /** npm package names or paths that contain skill folders. */
  readonly packages?: readonly string[];
  readonly shell?: boolean;
  readonly shellTimeoutMs?: number;
  readonly confirmShell?: (input: BashConfirmInput) => boolean | Promise<boolean>;
  readonly glob?: boolean;
  readonly grep?: boolean;
  readonly list?: boolean;
  readonly write?: boolean;
  readonly todos?: boolean;
  readonly askUser?: QuestionHandler;
  readonly web?: boolean | SkillsToolboxWebOptions;
  readonly memories?: boolean | SkillsToolboxMemoriesOptions;
  readonly task?: boolean | SkillsToolboxTaskOptions;
  readonly chatModel?: ChatModel;
  readonly perSkillSandbox?: boolean;
  /**
   * Retrieve a small Skill catalog from a build-time semantic index. When
   * omitted, the default index is used automatically if it exists.
   */
  readonly semanticDiscovery?: boolean | SkillsSemanticDiscoveryOptions;
}

export interface SkillsToolbox {
  readonly skills: readonly AgentSkill[];
  readonly allowedDirectories: readonly string[];
  readonly tools: readonly ToolCallback[];
  readonly runtime: SkillsRuntime;
  readonly retrievalAdvisor?: SkillsRetrievalAdvisor;
}

/** Preferred factory: {@code SkillsToolbox.builder().addSkillsDirectory(...).build()}. */
export const SkillsToolbox = {
  builder(): SkillsToolboxBuilder {
    return new SkillsToolboxBuilder();
  },
  of(options: SkillsToolboxOptions = {}): SkillsToolbox {
    return createSkillsToolbox(options);
  },
};

export class SkillsToolboxBuilder extends SkillsFluent<SkillsToolboxBuilder> {
  build(): SkillsToolbox {
    return SkillsToolbox.of(this.toOptions());
  }

  buildTools(): ToolCallback[] {
    return this.build().tools as ToolCallback[];
  }
}

/**
 * Skill + file tools + optional mutation / HITL / web / memory / task tools.
 * Prefer {@link SkillsToolbox.builder}.
 */
export function skillsToolbox(options: SkillsToolboxOptions = {}): ToolCallback[] {
  return SkillsToolbox.of(options).tools as ToolCallback[];
}

export function createSkillsToolbox(options: SkillsToolboxOptions = {}): SkillsToolbox {
  const directories = resolveToolboxDirectories(options);
  const files = options.files == null ? undefined : options.files.map(expandUserPath);
  const collected = collectSkills({
    ...options,
    directories,
    files,
  });

  for (const skill of collected) {
    validateSkill(skill, { matchDirectoryName: skill.basePath !== '.' });
  }

  const workspace = options.workspace ? expandUserPath(options.workspace) : process.cwd();
  const extra = (options.extraAllowedDirectories ?? []).map(expandUserPath);
  const skillDirectories = collected.map((skill) => skill.basePath).filter((path) => path !== '.');
  const allowedDirectories = uniqueResolvedRoots([workspace, ...skillDirectories, ...extra]);
  const runtime = createSkillsRuntime({
    workspace,
    extraAllowedDirectories: extra,
    skillDirectories,
    perSkillSandbox: options.perSkillSandbox,
  });
  const dirs = () => runtime.fileDirectories();

  const buildSkillTool = (skills: readonly AgentSkill[]): ToolCallback =>
    gateToolCallback(
      skillsTool({
        ...options,
        skills,
        directories: undefined,
        files: undefined,
        onActivate: (skill) => {
          runtime.activate(skill);
          options.onActivate?.(skill);
        },
      }),
      runtime,
    );

  const raw: ToolCallback[] = [buildSkillTool(collected), readTool({ allowedDirectories: dirs })];

  if (options.list !== false) {
    raw.push(listDirectoryTool({ allowedDirectories: dirs, workingDirectory: workspace }));
  }
  if (options.glob !== false) {
    raw.push(globTool({ allowedDirectories: dirs, workingDirectory: workspace }));
  }
  if (options.grep !== false) {
    raw.push(grepTool({ allowedDirectories: dirs, workingDirectory: workspace }));
  }
  if (options.write) {
    raw.push(writeTool({ allowedDirectories: dirs }), editTool({ allowedDirectories: dirs }));
  }
  if (options.shell) {
    raw.push(
      bashTool({
        allowedDirectories: dirs,
        workingDirectory: workspace,
        timeoutMs: options.shellTimeoutMs,
        confirm: options.confirmShell,
      }),
    );
  }
  if (options.todos !== false) {
    raw.push(todoWriteTool());
  }
  if (options.askUser) {
    raw.push(askUserQuestionTool({ questionHandler: options.askUser }));
  }

  const web = normalizeWeb(options.web);
  if (web.fetch) raw.push(webFetchTool());
  if (web.search) raw.push(webSearchTool({ apiKey: web.braveApiKey }));

  const memoriesDir = resolveMemoriesDir(options.memories, workspace);
  if (memoriesDir) {
    raw.push(...memoryTools({ directory: memoriesDir }));
  }

  const taskModel = resolveTaskModel(options);
  if (taskModel) {
    const withoutTask = raw.filter((tool) => tool.toolDefinition.name !== 'Task');
    raw.push(
      taskTool({
        chatModel: taskModel,
        tools: withoutTask,
        system: typeof options.task === 'object' ? options.task.system : undefined,
      }),
    );
  }

  const tools = raw.map((tool) =>
    tool.toolDefinition.name === (options.toolName ?? DEFAULT_SKILL_TOOL_NAME)
      ? tool
      : gateToolCallback(tool, runtime),
  );
  const retrievalAdvisor = createRetrievalAdvisor(options, workspace, collected, buildSkillTool);
  return { skills: collected, allowedDirectories, tools, runtime, retrievalAdvisor };
}

function createRetrievalAdvisor(
  options: SkillsToolboxOptions,
  workspace: string,
  skills: readonly AgentSkill[],
  buildSkillTool: (skills: readonly AgentSkill[]) => ToolCallback,
): SkillsRetrievalAdvisor | undefined {
  if (options.semanticDiscovery === false) return undefined;
  const discovery =
    options.semanticDiscovery && typeof options.semanticDiscovery === 'object'
      ? options.semanticDiscovery
      : {};
  const configuredPath = discovery.indexFile ?? DEFAULT_SKILLS_INDEX_FILE;
  const indexFile = isAbsolute(configuredPath)
    ? resolve(expandUserPath(configuredPath))
    : resolve(workspace, configuredPath);
  const explicit =
    options.semanticDiscovery === true || typeof options.semanticDiscovery === 'object';
  if (!discovery.vectorSearch && !existsSync(indexFile)) {
    if (explicit) {
      throw new Error(
        `Skills index does not exist: ${indexFile}. Build it with SkillsIndex.builder()`,
      );
    }
    return undefined;
  }

  const index = discovery.vectorSearch ? undefined : loadSkillsIndex(indexFile);
  if (index && !index.metadata.indexed) return undefined;
  return new SkillsRetrievalAdvisor({
    index,
    skills,
    catalogStore: discovery.catalogStore,
    vectorSearch: discovery.vectorSearch,
    namespace: discovery.namespace,
    embedder: discovery.embedder,
    limit: discovery.limit,
    minScore: discovery.minScore,
    recentUserMessages: discovery.recentUserMessages,
    toolName: options.toolName,
    toolOptions: {
      toolName: options.toolName,
      toolDescriptionTemplate: options.toolDescriptionTemplate,
      onActivate: options.onActivate,
    },
    // buildSkillTool already includes activation and the runtime gate.
    createTool: buildSkillTool,
  });
}

function resolveToolboxDirectories(options: SkillsToolboxOptions): string[] {
  const fromPackages = options.packages?.length
    ? resolveSkillPackageDirectories(options.packages, options.workspace ?? process.cwd())
    : [];
  if (options.directories != null) {
    return [...options.directories.map(expandUserPath), ...fromPackages];
  }
  const hasExplicitSkills = (options.files?.length ?? 0) > 0 || (options.skills?.length ?? 0) > 0;
  if (hasExplicitSkills) return fromPackages;
  return [...existingSkillDirectories(), ...fromPackages];
}

function normalizeWeb(web: SkillsToolboxOptions['web']): {
  fetch: boolean;
  search: boolean;
  braveApiKey?: string;
} {
  if (web === true) return { fetch: true, search: true };
  if (web == null || web === false) return { fetch: false, search: false };
  return {
    fetch: web.fetch !== false,
    search: web.search === true || web.braveApiKey != null,
    braveApiKey: web.braveApiKey,
  };
}

function resolveMemoriesDir(
  memories: SkillsToolboxOptions['memories'],
  workspace: string,
): string | undefined {
  if (memories === true) return `${workspace.replace(/[/\\]$/, '')}/.memory`;
  if (memories && typeof memories === 'object') return expandUserPath(memories.directory);
  return undefined;
}

function resolveTaskModel(options: SkillsToolboxOptions): ChatModel | undefined {
  if (options.task === false || options.task == null) return undefined;
  if (options.task === true) return options.chatModel;
  return options.task.chatModel;
}
