/**
 * `@di-framework/ai` — Spring AI-inspired portable AI integration for di-framework.
 *
 * Phase 1: model layer (messages, Prompt, ChatModel, ChatResponse, test doubles).
 * Phase 2: ChatClient + advisors.
 * Phase 3: tools (ToolCallback, ToolCallingManager, ToolCallingAdvisor).
 * Phase 4: structured output (converters, entity(), validation advisor).
 * Phase 5: memory (ChatMemory, MessageWindowChatMemory, MessageChatMemoryAdvisor).
 * Phase 6: retrieval (Document, VectorStore, RAG advisor).
 * Phase 7: providers (OpenAI-compatible, Anthropic).
 * Phase 8: MCP (ToolCallback adapters for Model Context Protocol).
 * Phase 9: workflows / agents (Anthropic effective-agent patterns).
 * Phase 10: DI integration (tokens, configureAi, @Tool, observation).
 */

export type {
  Advisor,
  AroundAdvisor,
  BeforeAfterAdvisorOptions,
  CallAdvisor,
  CallAdvisorChain,
  CallResponseSpec,
  ChatClientAttributeKey,
  ChatClientBuilder,
  ChatClientBuilderOptions,
  ChatClientRequest,
  ChatClientRequestSpec,
  ChatClientResponse,
  EntityInput,
  EntityParamSpec,
  EntityResponse,
  MessageChatMemoryAdvisorOptions,
  SimpleLoggerAdvisorOptions,
  StreamAdvisor,
  StreamAdvisorChain,
  StreamResponseSpec,
  StructuredOutputValidationAdvisorOptions,
  ToolAdvisor,
  ToolCallingAdvisorOptions,
  ToolSource,
} from './chat/client/index.ts';
// ChatClient + advisors
export {
  augmentWithFormatInstructions,
  ChatClient,
  ChatClientAttributes,
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
  isToolAdvisor,
  LOWEST_PRECEDENCE,
  MessageChatMemoryAdvisor,
  MessageChatMemoryAdvisorBuilder,
  renderTemplate,
  SimpleLoggerAdvisor,
  StructuredOutputValidationAdvisor,
  TOOL_CALLING_ADVISOR_AUTO_REGISTER,
  ToolCallingAdvisor,
  ToolCallingAdvisorBuilder,
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
// Model
export type { ChatModel, StreamingChatModel } from './chat/model/chat-model.ts';
export { ChatResponse } from './chat/model/chat-response.ts';
export type { Generation, GenerationMetadata } from './chat/model/generation.ts';
export { generation } from './chat/model/generation.ts';
// Prompt
export type { ChatOptions } from './chat/prompt/chat-options.ts';
export {
  chatOptions,
  hasToolCallingOptions,
  mergeChatOptions,
} from './chat/prompt/chat-options.ts';
export { Prompt } from './chat/prompt/prompt.ts';
// Content
export type { Media } from './content/media.ts';
export { media } from './content/media.ts';

// ChatClient is a value (factory) + interface type via declaration merge in default-chat-client.

// Agents / workflows (Spring AI effective-agent patterns)
export type {
  ChainStep,
  ChainWorkflowResult,
  ChatAgentOptions,
  ChatAgentResult,
  ChatAgentRunOptions,
  EvaluationResponse,
  EvaluatorOptimizerWorkflowOptions,
  GenerationRecord,
  OrchestratorPlan,
  OrchestratorWorkersResult,
  OrchestratorWorkersWorkflowOptions,
  ParallelizationWorkflowOptions,
  RefinedResponse,
  RouteHandler,
  RouteMap,
  RoutingWorkflowOptions,
  RoutingWorkflowResult,
  WorkerResponse,
  WorkerTask,
  WorkflowCallOptions,
} from './agent/index.ts';
export {
  ChainWorkflow,
  ChatAgent,
  callChatContent,
  callChatEntity,
  chainWorkflow,
  chatAgent,
  EvaluatorOptimizerWorkflow,
  evaluatorOptimizerWorkflow,
  extractJsonObject,
  mapPool,
  OrchestratorWorkersWorkflow,
  orchestratorWorkersWorkflow,
  ParallelizationWorkflow,
  parallelizationWorkflow,
  RoutingWorkflow,
  routingWorkflow,
  throwIfAborted,
} from './agent/index.ts';
// Memory
export type {
  ChatMemory,
  ChatMemoryRepository,
  MessageWindowChatMemoryOptions,
} from './chat/memory/index.ts';
export {
  addMessage,
  CHAT_MEMORY_CONVERSATION_ID,
  ChatMemoryKeys,
  InMemoryChatMemoryRepository,
  MessageWindowChatMemory,
  MessageWindowChatMemoryBuilder,
  messagesEqual,
  processWindow,
} from './chat/memory/index.ts';
// Structured output converters
export type {
  ResponseTextCleaner,
  SchemaOutputConverterOptions,
  SchemaValidationResult,
  StructuredOutputConverter,
} from './converter/index.ts';
export {
  compositeResponseTextCleaner,
  defaultResponseTextCleaner,
  isStructuredOutputConverter,
  listOutputConverter,
  mapOutputConverter,
  markdownCodeBlockCleaner,
  NO_JSON_SCHEMA,
  SchemaOutputConverter,
  schemaOutputConverter,
  schemaValidationFailed,
  schemaValidationOk,
  thinkingTagCleaner,
  validateAgainstJsonSchema,
  whitespaceCleaner,
} from './converter/index.ts';
// DI integration (di-framework-core)
export type {
  AiChatErrorEvent,
  AiChatRequestEvent,
  AiChatResponseEvent,
  AiContainer,
  AiEventName,
  AiToken,
  ConfigureAiOptions,
  ConfigureAiResult,
  ContainerLike,
  ObservationAdvisorOptions,
  ObservationRegistrationOptions,
  RegisterOptions,
  ToolDecoratorOptions,
  ToolMethodMetadata,
} from './di/index.ts';
export {
  AI_TOOL_METADATA_KEY,
  AiEvents,
  AiTokens,
  asAiContainer,
  asFactory,
  configureAi,
  getToolMethodMetadata,
  hasToolMethods,
  isModelLike,
  ObservationAdvisor,
  observationAdvisor,
  registerChatClient,
  registerChatMemory,
  registerChatModel,
  registerFactoryAliases,
  registerOnContainer,
  registerToolCallbacks,
  resolveChatClient,
  resolveChatModel,
  Tool,
  toolCallbackProviderFromBeans,
  toolCallbacksFromBean,
  toolCallbacksFromBeans,
} from './di/index.ts';
// Document
export type { Document, DocumentOptions } from './document/index.ts';
export {
  document,
  isTextDocument,
  textDocument,
  withDocumentScore,
} from './document/index.ts';
// Embedding
export type { EmbeddingModel, FakeEmbeddingModelOptions } from './embedding/index.ts';
export {
  bagOfWordsEmbedding,
  cosineSimilarity,
  embedDocument,
  FakeEmbeddingModel,
  l2Normalize,
} from './embedding/index.ts';
// MCP (Model Context Protocol → ToolCallback)
export type {
  AdaptSdkClientOptions,
  McpCallToolParams,
  McpCallToolResult,
  McpClientSession,
  McpConnectionInfo,
  McpContentBlock,
  McpListToolsResult,
  McpToolCallbackOptions,
  McpToolCallbackProviderOptions,
  McpToolDescriptor,
  McpToolFilter,
  McpToolHandler,
  McpToolNamePrefixGenerator,
  SdkMcpClientLike,
  ToolContextToMcpMetaConverter,
} from './mcp/index.ts';
export {
  adaptSdkClient,
  contentBlocksToString,
  createMcpToolCallbackProvider,
  createToolDefinitionFromMcp,
  defaultMcpToolNamePrefixGenerator,
  defaultToolContextToMcpMetaConverter,
  emptyConnectionInfo,
  formatToken,
  McpToolCallback,
  McpToolCallbackProvider,
  mcpResultToString,
  mcpToolCallback,
  mcpToolCallbacks,
  noPrefixMcpToolNameGenerator,
  prefixedToolName,
  TOOL_CONTEXT_MCP_EXCHANGE_KEY,
  toolCallbackAsMcpTool,
  toolCallbackToMcpDescriptor,
  toolCallbackToMcpHandler,
} from './mcp/index.ts';
// Errors
export type { AiErrorCode, AiErrorDetails } from './model/errors.ts';
export { AiError, cancelledError, isAiError } from './model/errors.ts';
// Tool calling manager
export type {
  DefaultToolCallingManagerOptions,
  ToolCallbackResolver,
  ToolCallingManager,
  ToolExecutionEligibilityChecker,
  ToolExecutionResult,
} from './model/tool/index.ts';
export {
  buildGenerationsFromToolExecution,
  createToolCallingManager,
  DefaultToolCallingManager,
  defaultToolExecutionEligibilityChecker,
  emptyToolCallbackResolver,
  staticToolCallbackResolver,
  TOOL_METADATA_TOOL_ID,
  TOOL_METADATA_TOOL_NAME,
  TOOL_RETURN_DIRECT_FINISH_REASON,
  toolExecutionResult,
} from './model/tool/index.ts';
// Providers (HTTP adapters — no vendor SDKs)
export type {
  AnthropicChatOptions,
  AnthropicContentBlock,
  AnthropicMappedPrompt,
  AnthropicMessage,
  AnthropicMessagesRequest,
  AnthropicMessagesResponse,
  AnthropicStreamEvent,
  AnthropicTool,
  FetchLike,
  HttpClientOptions,
  JsonRequestOptions,
  OpenAiChatCompletionRequest,
  OpenAiChatCompletionResponse,
  OpenAiChatMessage,
  OpenAiChatOptions,
  OpenAiChoice,
  OpenAiFunctionTool,
  OpenAiToolCall,
  OpenAiUsage,
} from './provider/index.ts';
export {
  AnthropicChatModel,
  anthropicChatModel,
  DEFAULT_ANTHROPIC_BASE_URL,
  DEFAULT_ANTHROPIC_MAX_TOKENS,
  DEFAULT_ANTHROPIC_MESSAGES_PATH,
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_ANTHROPIC_VERSION,
  DEFAULT_OPENAI_BASE_URL,
  DEFAULT_OPENAI_COMPLETIONS_PATH,
  DEFAULT_OPENAI_MODEL,
  fetchJson,
  fetchSseJson,
  joinUrl,
  mapHttpError,
  OpenAiChatModel,
  openAiChatModel,
  parseJsonSchemaString,
  requireApiKey,
  resolveAnthropicApiKey,
  resolveOpenAiApiKey,
  toAnthropicMessages,
  toAnthropicTools,
  toOpenAiMessages,
  toOpenAiToolCall,
  toOpenAiTools,
} from './provider/index.ts';
// RAG
export type {
  ContextualQueryAugmenterOptions,
  DocumentJoiner,
  DocumentPostProcessor,
  DocumentRetriever,
  Query,
  QueryAugmenter,
  QueryExpander,
  QueryOptions,
  QueryTransformer,
  RetrievalAugmentationAdvisorOptions,
  VectorStoreDocumentRetrieverOptions,
} from './rag/index.ts';
export {
  ConcatenationDocumentJoiner,
  ContextualQueryAugmenter,
  mutateQuery,
  query,
  RAG_DOCUMENT_CONTEXT,
  RetrievalAugmentationAdvisor,
  VECTOR_STORE_FILTER_EXPRESSION,
  VectorStoreDocumentRetriever,
} from './rag/index.ts';
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
// Tools
export type {
  FunctionToolCallbackOptions,
  ToolCallback,
  ToolCallbackProvider,
  ToolCallResultConverter,
  ToolDefinition,
  ToolExecutionExceptionProcessor,
  ToolFunction,
  ToolMetadata,
} from './tool/index.ts';
export {
  DEFAULT_TOOL_INPUT_SCHEMA,
  DEFAULT_TOOL_METADATA,
  defaultToolCallResultConverter,
  defaultToolExecutionExceptionProcessor,
  FunctionToolCallback,
  functionToolCallback,
  getToolMetadata,
  isToolCallback,
  isToolCallbackProvider,
  resolveToolCallbacks,
  staticToolCallbackProvider,
  ToolContext,
  ToolExecutionException,
  toolDefinition,
  toolMetadata,
  validateUniqueToolNames,
} from './tool/index.ts';
// Vector store
export type {
  FilterExpression,
  FilterGroup,
  FilterKey,
  FilterOperand,
  FilterValue,
  SearchRequest,
  SearchRequestOptions,
  SimpleVectorStoreOptions,
  VectorStore,
  VectorStoreRetriever,
} from './vectorstore/index.ts';
export {
  DEFAULT_TOP_K,
  evaluateFilterExpression,
  FilterExpressionBuilder,
  FilterExpressionType as FilterType,
  FilterExpressionType,
  FilterOp,
  filterExpression,
  filterGroup,
  filterKey,
  filterValue,
  isFilterExpression,
  parseFilterExpression,
  SearchRequestBuilder,
  SIMILARITY_THRESHOLD_ACCEPT_ALL,
  SimpleVectorStore,
  SimpleVectorStoreBuilder,
  searchRequest,
  searchRequestBuilder,
  similaritySearchQuery,
} from './vectorstore/index.ts';
