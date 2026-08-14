import {
  type Advisor,
  ChatAgent,
  type ChatClient,
  type ChatClientBuilderOptions,
  type ChatMemory,
  type ChatModel,
  type ChatOptions,
  type ToolSource,
} from '@di-framework/ai';
import { formatMemorySystemPrompt } from '../tools/memory-tools.ts';
import {
  createSkillsToolbox,
  type SkillsToolbox,
  type SkillsToolboxOptions,
} from './skills-toolbox.ts';

export interface CreateSkillsAgentOptions extends SkillsToolboxOptions {
  readonly chatModel?: ChatModel;
  readonly chatClient?: ChatClient;
  readonly system?: string;
  readonly extraTools?: readonly ToolSource[];
  readonly defaultOptions?: ChatOptions;
  readonly advisors?: readonly Advisor[];
  readonly conversationMemory?: ChatMemory;
  readonly defaultConversationId?: string;
  readonly builder?: ChatClientBuilderOptions;
}

export interface SkillsAgentBundle {
  readonly agent: ChatAgent;
  readonly toolbox: SkillsToolbox;
}

/**
 * ChatAgent with {@link createSkillsToolbox} attached. Skills stay in this
 * package — {@code configureAi} / {@code @Agent} are unchanged.
 */
export function createSkillsAgent(options: CreateSkillsAgentOptions): ChatAgent {
  return createSkillsAgentBundle(options).agent;
}

export function createSkillsAgentBundle(options: CreateSkillsAgentOptions): SkillsAgentBundle {
  const toolbox = createSkillsToolbox(options);
  const memoriesDir =
    options.memories === true
      ? `${(options.workspace ?? process.cwd()).replace(/[/\\]$/, '')}/.memory`
      : options.memories && typeof options.memories === 'object'
        ? options.memories.directory
        : undefined;
  const systemParts = [
    options.system,
    memoriesDir ? formatMemorySystemPrompt(memoriesDir) : undefined,
  ].filter((part): part is string => Boolean(part?.trim()));

  const agent = ChatAgent.create({
    chatModel: options.chatModel,
    chatClient: options.chatClient,
    system: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
    tools: [...toolbox.tools, ...(options.extraTools ?? [])],
    defaultOptions: options.defaultOptions,
    advisors: options.advisors,
    memory: options.conversationMemory,
    defaultConversationId: options.defaultConversationId,
    builder: options.builder,
  });
  return { agent, toolbox };
}
