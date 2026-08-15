import {
  type CallAdvisor,
  type CallAdvisorChain,
  type ChatClientRequest,
  type ChatClientResponse,
  copyChatClientRequest,
  HIGHEST_PRECEDENCE,
  Prompt,
  type StreamAdvisor,
  type StreamAdvisorChain,
  type ToolCallback,
} from '@di-framework/ai';
import type { AgentSkill } from './parse-skill-markdown.ts';
import type { SkillEmbedder } from './skill-embedder.ts';
import {
  assertSkillsIndexCurrent,
  loadSkillsIndex,
  type SkillsIndex,
  type SkillsIndexMatch,
  searchSkillsIndex,
} from './skills-index.ts';
import { DEFAULT_SKILL_TOOL_NAME, type SkillsToolOptions, skillsTool } from './skills-tool.ts';

export const SKILLS_RETRIEVAL_CONTEXT = 'skills_retrieval';
export const DEFAULT_SKILLS_RETRIEVAL_ORDER = HIGHEST_PRECEDENCE + 250;

export interface SkillsRetrievalAdvisorOptions {
  readonly index: SkillsIndex | string;
  readonly skills: readonly AgentSkill[];
  readonly embedder?: SkillEmbedder;
  readonly limit?: number;
  readonly minScore?: number;
  readonly order?: number;
  readonly recentUserMessages?: number;
  readonly toolName?: string;
  readonly toolOptions?: Omit<SkillsToolOptions, 'skills' | 'directories' | 'files'>;
  /** Used by SkillsToolbox to preserve activation state and its runtime gate. */
  readonly createTool?: (skills: readonly AgentSkill[]) => ToolCallback;
}

/**
 * Replaces the full Skill catalog with the most relevant indexed subset before
 * the model sees the request. It runs after memory and before tool calling.
 */
export class SkillsRetrievalAdvisor implements CallAdvisor, StreamAdvisor {
  readonly name = 'Skills Retrieval Advisor';
  readonly order: number;

  private readonly index: SkillsIndex;
  private readonly skillsByName: ReadonlyMap<string, AgentSkill>;
  private readonly embedder?: SkillEmbedder;
  private readonly limit?: number;
  private readonly minScore?: number;
  private readonly recentUserMessages: number;
  private readonly toolName: string;
  private readonly toolOptions: Omit<SkillsToolOptions, 'skills' | 'directories' | 'files'>;
  private readonly createTool: (skills: readonly AgentSkill[]) => ToolCallback;

  constructor(options: SkillsRetrievalAdvisorOptions) {
    this.index = typeof options.index === 'string' ? loadSkillsIndex(options.index) : options.index;
    assertSkillsIndexCurrent(this.index, options.skills, { allowExtraSkills: true });
    this.skillsByName = new Map(options.skills.map((skill) => [skill.name, skill]));
    this.embedder = options.embedder;
    this.limit = options.limit;
    this.minScore = options.minScore;
    this.order = options.order ?? DEFAULT_SKILLS_RETRIEVAL_ORDER;
    this.recentUserMessages = positiveInteger(
      options.recentUserMessages ?? 3,
      'recentUserMessages',
    );
    this.toolName = options.toolName ?? DEFAULT_SKILL_TOOL_NAME;
    this.toolOptions = options.toolOptions ?? {};
    this.createTool =
      options.createTool ??
      ((skills) =>
        skillsTool({
          ...this.toolOptions,
          skills,
          toolName: this.toolName,
        }));
  }

  async before(request: ChatClientRequest): Promise<ChatClientRequest> {
    if (!this.index.metadata.indexed) return request;
    const callbacks = request.prompt.options?.toolCallbacks;
    if (!callbacks?.some((tool) => tool.toolDefinition.name === this.toolName)) return request;

    const task = this.taskText(request);
    const semantic = await searchSkillsIndex(this.index, task, {
      embedder: this.embedder,
      limit: this.limit,
      minScore: this.minScore,
    });
    const matches = this.pinExplicitSkillNames(task, semantic);
    const selected = matches
      .map((match) => this.skillsByName.get(match.name))
      .filter((skill): skill is AgentSkill => skill != null);

    if (selected.length === 0) {
      throw new Error('Semantic skill discovery did not return any skills for this request');
    }

    const replacement = this.createTool(selected);
    const toolCallbacks = callbacks.map((tool) =>
      tool.toolDefinition.name === this.toolName ? replacement : tool,
    );
    request.context.set(SKILLS_RETRIEVAL_CONTEXT, matches);
    return copyChatClientRequest(request, {
      prompt: new Prompt(request.prompt.messages, {
        ...request.prompt.options,
        toolCallbacks,
      }),
      context: request.context,
    });
  }

  async adviseCall(
    request: ChatClientRequest,
    chain: CallAdvisorChain,
  ): Promise<ChatClientResponse> {
    return chain.nextCall(await this.before(request));
  }

  async *adviseStream(
    request: ChatClientRequest,
    chain: StreamAdvisorChain,
  ): AsyncIterable<ChatClientResponse> {
    yield* chain.nextStream(await this.before(request));
  }

  private taskText(request: ChatClientRequest): string {
    const messages = request.prompt.getUserMessages().slice(-this.recentUserMessages);
    const task = messages
      .map((message) => message.text ?? '')
      .filter((text) => text.trim().length > 0)
      .join('\n\n');
    return task || request.prompt.getContents();
  }

  private pinExplicitSkillNames(
    task: string,
    semantic: readonly SkillsIndexMatch[],
  ): readonly SkillsIndexMatch[] {
    const limit = this.limit ?? this.index.metadata.retrievalLimit;
    const lowerTask = task.toLowerCase();
    const explicit = this.index.entries
      .filter((entry) => containsSkillName(lowerTask, entry.name))
      .map((entry) => ({
        name: entry.name,
        description: entry.description,
        score: 1,
        matchedChunk: 0,
        matchedSource: 'document' as const,
      }));
    if (explicit.length === 0) return semantic;

    const merged = new Map<string, SkillsIndexMatch>();
    for (const match of [...explicit, ...semantic]) {
      if (!merged.has(match.name)) merged.set(match.name, match);
    }
    return [...merged.values()].slice(0, Math.max(limit, explicit.length));
  }
}

function containsSkillName(lowerTask: string, name: string): boolean {
  const lowerName = name.toLowerCase();
  let start = lowerTask.indexOf(lowerName);
  while (start >= 0) {
    const before = start === 0 ? '' : lowerTask.charAt(start - 1);
    const afterIndex = start + lowerName.length;
    const after = afterIndex === lowerTask.length ? '' : lowerTask.charAt(afterIndex);
    if (!/[a-z0-9-]/.test(before) && !/[a-z0-9-]/.test(after)) return true;
    start = lowerTask.indexOf(lowerName, start + 1);
  }
  return false;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}
