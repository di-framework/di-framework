import type { Advisor } from '../chat/client/advisor/advisor.ts';
import { MessageChatMemoryAdvisor } from '../chat/client/advisor/message-chat-memory-advisor.ts';
import {
  ChatClient,
  type ChatClientBuilderOptions,
  type ToolSource,
} from '../chat/client/default-chat-client.ts';
import { CHAT_MEMORY_CONVERSATION_ID, type ChatMemory } from '../chat/memory/chat-memory.ts';
import type { ChatModel } from '../chat/model/chat-model.ts';
import type { ChatOptions } from '../chat/prompt/chat-options.ts';
import type { ToolCallback } from '../tool/tool-callback.ts';
import { resolveToolCallbacks } from '../tool/tool-callback-provider.ts';
import { throwIfAborted } from './workflow-utils.ts';

export interface ChatAgentOptions {
  readonly chatModel?: ChatModel;
  readonly chatClient?: ChatClient;
  readonly system?: string;
  readonly tools?: readonly ToolSource[];
  readonly defaultOptions?: ChatOptions;
  readonly advisors?: readonly Advisor[];
  /**
   * Optional memory; when set, each {@link chat} requires a conversation id
   * (argument or {@link ChatAgentOptions.defaultConversationId}).
   */
  readonly memory?: ChatMemory;
  readonly defaultConversationId?: string;
  readonly builder?: ChatClientBuilderOptions;
}

export interface ChatAgentRunOptions {
  readonly conversationId?: string;
  readonly signal?: AbortSignal;
  readonly options?: ChatOptions;
  readonly tools?: readonly ToolSource[];
  readonly advisorContext?: Readonly<Record<string, unknown>>;
}

export interface ChatAgentResult {
  readonly content: string;
  readonly conversationId?: string;
}

/**
 * LLM-directed agent: a preconfigured {@link ChatClient} with tools (and optional memory).
 *
 * This is the “agent” side of Anthropic/Spring AI’s distinction —
 * the model dynamically chooses tools via {@code ToolCallingAdvisor}.
 * Prefer fixed {@link ChainWorkflow} / routing / etc. when the path is known.
 *
 * @example
 * ```ts
 * const agent = ChatAgent.create({
 *   chatModel: model,
 *   system: "You help with weather questions.",
 *   tools: [weatherTool],
 * });
 * const { content } = await agent.chat("Weather in Yorktown?");
 * ```
 */
export class ChatAgent {
  private readonly chatClient: ChatClient;
  private readonly defaultConversationId?: string;
  private readonly hasMemory: boolean;

  private constructor(
    chatClient: ChatClient,
    options: { defaultConversationId?: string; hasMemory: boolean },
  ) {
    this.chatClient = chatClient;
    this.defaultConversationId = options.defaultConversationId;
    this.hasMemory = options.hasMemory;
  }

  static create(options: ChatAgentOptions): ChatAgent {
    if (!options.chatClient && !options.chatModel) {
      throw new Error('ChatAgent requires chatModel or chatClient');
    }

    let client = options.chatClient;
    if (!client) {
      const advisors: Advisor[] = [...(options.advisors ?? [])];
      if (options.memory) {
        advisors.push(new MessageChatMemoryAdvisor({ chatMemory: options.memory }));
      }
      const tools = options.tools ? resolveToolCallbacks(...options.tools) : undefined;

      let builder = ChatClient.builder(options.chatModel!);
      if (options.system) builder = builder.defaultSystem(options.system);
      if (options.defaultOptions) {
        builder = builder.defaultOptions(options.defaultOptions);
      }
      if (advisors.length) builder = builder.defaultAdvisors(...advisors);
      if (tools?.length) builder = builder.defaultTools(...tools);
      if (options.builder?.defaultContext) {
        builder = builder.defaultContext(options.builder.defaultContext);
      }
      client = builder.build();
    }

    return new ChatAgent(client, {
      defaultConversationId: options.defaultConversationId,
      hasMemory: Boolean(options.memory) || Boolean(options.defaultConversationId),
    });
  }

  /** Underlying client (for advanced composition). */
  get client(): ChatClient {
    return this.chatClient;
  }

  async chat(message: string, runOptions?: ChatAgentRunOptions): Promise<ChatAgentResult> {
    throwIfAborted(runOptions?.signal);

    const conversationId = runOptions?.conversationId ?? this.defaultConversationId;

    let spec = this.chatClient.prompt().user(message);

    if (runOptions?.options || runOptions?.signal) {
      spec = spec.options({
        ...runOptions?.options,
        signal: runOptions?.signal ?? runOptions?.options?.signal,
      });
    }

    if (runOptions?.tools?.length) {
      const tools = resolveToolCallbacks(...(runOptions.tools as ToolSource[])) as ToolCallback[];
      spec = spec.tools(...tools);
    }

    const context: Record<string, unknown> = {
      ...runOptions?.advisorContext,
    };
    if (conversationId) {
      context[CHAT_MEMORY_CONVERSATION_ID] = conversationId;
    }
    if (Object.keys(context).length > 0) {
      spec = spec.advisorContext(context);
    }

    const content = (await spec.call().content()) ?? '';
    return { content, conversationId };
  }
}

export function chatAgent(options: ChatAgentOptions): ChatAgent {
  return ChatAgent.create(options);
}
