/**
 * Well-known string tokens for AI services in the di-framework container.
 *
 * Prefer these over ad-hoc names so `@Component(AiTokens.CHAT_MODEL)` and
 * `configureAi()` stay consistent across apps.
 */
export const AiTokens = {
  /** Primary / default chat model. */
  CHAT_MODEL: "chatModel",
  /** Named default model alias (Spring-style `chat.default`). */
  CHAT_MODEL_DEFAULT: "chat.default",
  /** Primary ChatClient built around the default model. */
  CHAT_CLIENT: "chatClient",
  /** Default chat memory bean. */
  CHAT_MEMORY: "chatMemory",
  /** Default embedding model. */
  EMBEDDING_MODEL: "embeddingModel",
  /** Default vector store. */
  VECTOR_STORE: "vectorStore",
  /**
   * Aggregated {@link import("../tool/tool-callback.ts").ToolCallback}[]
   * (or ToolCallbackProvider) discovered from `@Tool` beans / configureAi.
   */
  TOOL_CALLBACKS: "ai.tools",
} as const;

export type AiToken = (typeof AiTokens)[keyof typeof AiTokens];
