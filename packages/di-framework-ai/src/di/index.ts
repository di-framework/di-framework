export { AiTokens, type AiToken } from "./tokens.ts";

export type {
  AiContainer,
  ContainerLike,
  RegisterOptions,
  ObservationRegistrationOptions,
  ConfigureAiOptions,
  ConfigureAiResult,
} from "./types.ts";

export {
  asAiContainer,
  asFactory,
  isModelLike,
  registerFactoryAliases,
  registerOnContainer,
} from "./container-utils.ts";

export {
  registerChatModel,
  registerChatClient,
  registerChatMemory,
  registerToolCallbacks,
  resolveChatModel,
  resolveChatClient,
  configureAi,
} from "./register.ts";

export {
  AI_TOOL_METADATA_KEY,
  Tool,
  getToolMethodMetadata,
  toolCallbacksFromBean,
  toolCallbacksFromBeans,
  toolCallbackProviderFromBeans,
  hasToolMethods,
  type ToolMethodMetadata,
  type ToolDecoratorOptions,
} from "./tool-decorator.ts";

export {
  AiEvents,
  ObservationAdvisor,
  observationAdvisor,
  type AiEventName,
  type AiChatRequestEvent,
  type AiChatResponseEvent,
  type AiChatErrorEvent,
  type ObservationAdvisorOptions,
} from "./observation.ts";
