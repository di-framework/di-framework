/**
 * `@di-framework/ai` — Spring AI-inspired portable AI integration for di-framework.
 *
 * Phase 1: model layer (messages, Prompt, ChatModel, ChatResponse, test doubles).
 * Phase 2: ChatClient + advisors.
 * Later: tools, memory, RAG, providers.
 */

export type {
  Advisor,
  AroundAdvisor,
  BeforeAfterAdvisorOptions,
  CallAdvisor,
  CallAdvisorChain,
  CallResponseSpec,
  ChatClientBuilder,
  ChatClientBuilderOptions,
  ChatClientRequest,
  ChatClientRequestSpec,
  ChatClientResponse,
  SimpleLoggerAdvisorOptions,
  StreamAdvisor,
  StreamAdvisorChain,
  StreamResponseSpec,
} from './chat/client/index.ts';
// ChatClient + advisors
export {
  ChatClient,
  ChatModelCallAdvisor,
  ChatModelStreamAdvisor,
  chatClientRequest,
  chatClientResponse,
  compareOrder,
  copyChatClientRequest,
  copyChatClientResponse,
  createBeforeAfterAdvisor,
  DEFAULT_CHAT_MEMORY_PRECEDENCE_ORDER,
  DEFAULT_TOOL_CALLING_ORDER,
  DefaultAdvisorChain,
  HIGHEST_PRECEDENCE,
  isCallAdvisor,
  isStreamAdvisor,
  LOWEST_PRECEDENCE,
  renderTemplate,
  SimpleLoggerAdvisor,
} from './chat/client/index.ts';
export {
  assistantMessage,
  systemMessage,
  toolCall,
  toolResponse,
  toolResponseMessage,
  userMessage,
} from './chat/messages/factories.ts';
export type {
  AssistantMessage,
  ChatMessage,
  Message,
  SystemMessage,
  ToolCall,
  ToolResponse,
  ToolResponseMessage,
  UserMessage,
} from './chat/messages/message.ts';
export {
  hasToolCalls,
  isAssistantMessage,
  isSystemMessage,
  isToolResponseMessage,
  isUserMessage,
} from './chat/messages/message.ts';
// Messages
export { MessageType } from './chat/messages/message-type.ts';
export type { ChatResponseMetadata } from './chat/metadata/chat-response-metadata.ts';
export { chatResponseMetadata } from './chat/metadata/chat-response-metadata.ts';
// Metadata
export type { Usage } from './chat/metadata/usage.ts';
export { usage } from './chat/metadata/usage.ts';
export type { ChatModel, StreamingChatModel } from './chat/model/chat-model.ts';
export { ChatResponse } from './chat/model/chat-response.ts';
// Model
export type { Generation, GenerationMetadata } from './chat/model/generation.ts';
export { generation } from './chat/model/generation.ts';
// Prompt
export type { ChatOptions } from './chat/prompt/chat-options.ts';
export { chatOptions, mergeChatOptions } from './chat/prompt/chat-options.ts';
export { Prompt } from './chat/prompt/prompt.ts';
// Content
export type { Media } from './content/media.ts';
export { media } from './content/media.ts';
// ChatClient is a value (factory) + interface type via declaration merge in default-chat-client.

// Errors
export type { AiErrorCode, AiErrorDetails } from './model/errors.ts';
export { AiError, cancelledError, isAiError } from './model/errors.ts';

// Testing
export {
  FakeChatModel,
  type FakeChatModelHandler,
  RecordingChatModel,
  requestContains,
  ScriptedChatModel,
  type ScriptedTurn,
  textResponse,
  toolCallResponse,
} from './testing/fake-chat-model.ts';
