import type { Advisor } from '../chat/client/advisor/advisor.ts';
import { MessageChatMemoryAdvisor } from '../chat/client/advisor/message-chat-memory-advisor.ts';
import type { ChatClient } from '../chat/client/default-chat-client.ts';
import { ChatClient as ChatClientFactory } from '../chat/client/default-chat-client.ts';
import type { ChatMemory } from '../chat/memory/chat-memory.ts';
import type { ChatModel } from '../chat/model/chat-model.ts';
import type { ToolCallback } from '../tool/tool-callback.ts';
import {
  resolveToolCallbacks,
  staticToolCallbackProvider,
} from '../tool/tool-callback-provider.ts';
import { asAiContainer, asFactory, registerFactoryAliases } from './container-utils.ts';
import { observationAdvisor } from './observation.ts';
import { AiTokens } from './tokens.ts';
import { toolCallbacksFromBean } from './tool-decorator.ts';
import type {
  ConfigureAiOptions,
  ConfigureAiResult,
  ContainerLike,
  RegisterOptions,
} from './types.ts';

/**
 * Register a {@link ChatModel} under a string token (default {@link AiTokens.CHAT_MODEL}).
 *
 * @example
 * ```ts
 * registerChatModel(new FakeChatModel("hi"), {
 *   aliases: [AiTokens.CHAT_MODEL_DEFAULT],
 * });
 * const model = useContainer().resolve<ChatModel>(AiTokens.CHAT_MODEL);
 * ```
 */
export function registerChatModel(
  model: ChatModel | (() => ChatModel),
  options: RegisterOptions = {},
): ChatModel | (() => ChatModel) {
  const container = asAiContainer(options.container);
  const token = options.token ?? AiTokens.CHAT_MODEL;
  const factory = asFactory(model);
  const aliases = options.aliases ?? [];
  registerFactoryAliases(container, factory, [token, ...aliases], options.singleton ?? true);
  return model;
}

/**
 * Register a {@link ChatClient} under a string token (default {@link AiTokens.CHAT_CLIENT}).
 */
export function registerChatClient(
  client: ChatClient | (() => ChatClient),
  options: RegisterOptions = {},
): ChatClient | (() => ChatClient) {
  const container = asAiContainer(options.container);
  const token = options.token ?? AiTokens.CHAT_CLIENT;
  const factory = asFactory(client);
  registerFactoryAliases(
    container,
    factory,
    [token, ...(options.aliases ?? [])],
    options.singleton ?? true,
  );
  return client;
}

/**
 * Register chat memory under {@link AiTokens.CHAT_MEMORY} (or custom token).
 */
export function registerChatMemory(
  memory: ChatMemory | (() => ChatMemory),
  options: RegisterOptions = {},
): ChatMemory | (() => ChatMemory) {
  const container = asAiContainer(options.container);
  const token = options.token ?? AiTokens.CHAT_MEMORY;
  registerFactoryAliases(
    container,
    asFactory(memory),
    [token, ...(options.aliases ?? [])],
    options.singleton ?? true,
  );
  return memory;
}

/**
 * Register tool callbacks under {@link AiTokens.TOOL_CALLBACKS}.
 */
export function registerToolCallbacks(
  tools: readonly ToolCallback[],
  options: RegisterOptions = {},
): readonly ToolCallback[] {
  const container = asAiContainer(options.container);
  const token = options.token ?? AiTokens.TOOL_CALLBACKS;
  const list = [...tools];
  registerFactoryAliases(
    container,
    () => list,
    [token, ...(options.aliases ?? [])],
    options.singleton ?? true,
  );
  return list;
}

/**
 * Resolve the default chat model from the container.
 */
export function resolveChatModel(
  container?: ContainerLike,
  token: string = AiTokens.CHAT_MODEL,
): ChatModel {
  return asAiContainer(container).resolve<ChatModel>(token);
}

/**
 * Resolve the default chat client from the container.
 */
export function resolveChatClient(
  container?: ContainerLike,
  token: string = AiTokens.CHAT_CLIENT,
): ChatClient {
  return asAiContainer(container).resolve<ChatClient>(token);
}

/**
 * Spring Boot–style “starter” setup: register model, optional memory/tools,
 * and a {@link ChatClient} factory with observation and tool-calling wired in.
 *
 * @example
 * ```ts
 * configureAi({
 *   chatModel: new OpenAiChatModel({ apiKey: process.env.OPENAI_API_KEY }),
 *   defaultSystem: "You are helpful.",
 *   toolBeans: [WeatherTools],
 *   observation: true,
 * });
 *
 * const client = resolveChatClient();
 * await client.prompt().user("Hi").call().content();
 * ```
 */
export function configureAi(options: ConfigureAiOptions): ConfigureAiResult {
  const container = asAiContainer(options.container);
  const chatModelToken = options.chatModelToken ?? AiTokens.CHAT_MODEL;
  const chatClientToken = options.chatClientToken ?? AiTokens.CHAT_CLIENT;
  const singleton = true;

  // --- Chat model ---
  if (options.chatModel) {
    const aliases: string[] = [];
    if (options.registerChatDefaultAlias !== false) {
      aliases.push(AiTokens.CHAT_MODEL_DEFAULT);
    }
    registerChatModel(options.chatModel, {
      container,
      token: chatModelToken,
      aliases,
      singleton,
    });
  }

  // --- Memory ---
  if (options.memory) {
    registerChatMemory(options.memory, {
      container,
      token: options.memoryToken ?? AiTokens.CHAT_MEMORY,
      singleton,
    });
  }

  // --- Embedding / vector (optional tokens only) ---
  if (options.embeddingModel) {
    registerFactoryAliases(
      container,
      asFactory(options.embeddingModel),
      [AiTokens.EMBEDDING_MODEL],
      singleton,
    );
  }
  if (options.vectorStore) {
    registerFactoryAliases(
      container,
      asFactory(options.vectorStore),
      [AiTokens.VECTOR_STORE],
      singleton,
    );
  }

  // --- Tools from beans + explicit sources ---
  const toolCallbacks = collectTools(container, options);
  if (toolCallbacks.length > 0) {
    registerToolCallbacks(toolCallbacks, { container, singleton });
  }

  // --- ChatClient factory ---
  const registerClient = options.registerChatClient !== false;
  if (registerClient) {
    registerChatClient(() => buildChatClient(container, chatModelToken, options, toolCallbacks), {
      container,
      token: chatClientToken,
      singleton,
    });
  }

  return {
    container,
    chatModelToken,
    chatClientToken: registerClient ? chatClientToken : undefined,
  };
}

function collectTools(
  container: ReturnType<typeof asAiContainer>,
  options: ConfigureAiOptions,
): ToolCallback[] {
  const fromSources = options.tools ? resolveToolCallbacks(...options.tools) : [];

  const fromBeans: ToolCallback[] = [];
  for (const bean of options.toolBeans ?? []) {
    const instance =
      typeof bean === 'function'
        ? container.resolve<object>(bean as new (...args: never[]) => object)
        : bean;
    fromBeans.push(...toolCallbacksFromBean(instance));
  }

  if (fromSources.length === 0 && fromBeans.length === 0) return [];
  return resolveToolCallbacks(fromSources, fromBeans);
}

function buildChatClient(
  container: ReturnType<typeof asAiContainer>,
  chatModelToken: string,
  options: ConfigureAiOptions,
  toolCallbacks: readonly ToolCallback[],
): ChatClient {
  const model = container.resolve<ChatModel>(chatModelToken);
  const advisors: Advisor[] = [...(options.advisors ?? [])];

  // Observation is opt-in (redacted by default when enabled).
  if (options.observation === true || typeof options.observation === 'object') {
    const obsOpts = typeof options.observation === 'object' ? options.observation : {};
    if (obsOpts.enabled !== false) {
      advisors.push(
        observationAdvisor({
          container,
          includePromptText: obsOpts.includePromptText,
          includeResponseText: obsOpts.includeResponseText,
        }),
      );
    }
  }

  if (options.memory || options.memoryToken) {
    try {
      const memory = container.resolve<ChatMemory>(options.memoryToken ?? AiTokens.CHAT_MEMORY);
      advisors.push(new MessageChatMemoryAdvisor({ chatMemory: memory }));
    } catch {
      // memory not registered — skip
    }
  }

  let builder = ChatClientFactory.builder(model);
  if (options.defaultSystem) {
    builder = builder.defaultSystem(options.defaultSystem);
  }
  if (options.defaultOptions) {
    builder = builder.defaultOptions(options.defaultOptions);
  }
  if (advisors.length) {
    builder = builder.defaultAdvisors(...advisors);
  }
  if (toolCallbacks.length) {
    builder = builder.defaultTools(staticToolCallbackProvider(toolCallbacks));
  }
  return builder.build();
}
