import { toolResponse, toolResponseMessage } from '../../chat/messages/factories.ts';
import {
  type AssistantMessage,
  type ChatMessage,
  isAssistantMessage,
  type ToolCall,
} from '../../chat/messages/message.ts';
import type { ChatResponse } from '../../chat/model/chat-response.ts';
import type { ChatOptions } from '../../chat/prompt/chat-options.ts';
import type { Prompt } from '../../chat/prompt/prompt.ts';
import type { ToolDefinition } from '../../tool/definition.ts';
import {
  defaultToolExecutionExceptionProcessor,
  ToolExecutionException,
  type ToolExecutionExceptionProcessor,
} from '../../tool/execution/tool-execution-exception.ts';
import type { ToolCallback } from '../../tool/tool-callback.ts';
import { getToolMetadata } from '../../tool/tool-callback.ts';
import { ToolContext } from '../../tool/tool-context.ts';
import { emptyToolCallbackResolver, type ToolCallbackResolver } from './tool-callback-resolver.ts';
import type { ToolCallingManager } from './tool-calling-manager.ts';
import { type ToolExecutionResult, toolExecutionResult } from './tool-execution-result.ts';

export interface DefaultToolCallingManagerOptions {
  readonly toolCallbackResolver?: ToolCallbackResolver;
  readonly toolExecutionExceptionProcessor?: ToolExecutionExceptionProcessor;
}

/**
 * Create a default {@link ToolCallingManager}.
 * Spring AI: {@code ToolCallingManager.builder().build()}.
 */
export function createToolCallingManager(
  options?: DefaultToolCallingManagerOptions,
): ToolCallingManager {
  return new DefaultToolCallingManager(options);
}

/**
 * Default {@link ToolCallingManager} implementation.
 * Spring AI: {@code DefaultToolCallingManager}.
 */
export class DefaultToolCallingManager implements ToolCallingManager {
  private readonly toolCallbackResolver: ToolCallbackResolver;
  private readonly exceptionProcessor: ToolExecutionExceptionProcessor;

  constructor(options: DefaultToolCallingManagerOptions = {}) {
    this.toolCallbackResolver = options.toolCallbackResolver ?? emptyToolCallbackResolver;
    this.exceptionProcessor =
      options.toolExecutionExceptionProcessor ?? defaultToolExecutionExceptionProcessor();
  }

  resolveToolDefinitions(chatOptions: ChatOptions): readonly ToolDefinition[] {
    const callbacks = chatOptions.toolCallbacks ?? [];
    return callbacks.map((cb) => cb.toolDefinition);
  }

  async executeToolCalls(prompt: Prompt, chatResponse: ChatResponse): Promise<ToolExecutionResult> {
    const assistant = findAssistantWithToolCalls(chatResponse);
    if (!assistant) {
      throw new Error('No tool call requested by the chat model');
    }

    const toolContext = buildToolContext(prompt);
    const callbacks = prompt.options?.toolCallbacks ?? [];

    const toolResponses: Array<{
      id: string;
      name: string;
      responseData: string;
    }> = [];

    let returnDirect: boolean | null = null;

    for (const call of assistant.toolCalls) {
      const result = await this.executeOne(call, callbacks, toolContext);
      toolResponses.push({
        id: call.id,
        name: call.name,
        responseData: result.responseData,
      });
      if (returnDirect === null) {
        returnDirect = result.returnDirect;
      } else {
        returnDirect = returnDirect && result.returnDirect;
      }
    }

    const toolMessage = toolResponseMessage(
      toolResponses.map((r) => toolResponse(r.id, r.name, r.responseData)),
    );

    const conversationHistory: ChatMessage[] = [...prompt.messages, assistant, toolMessage];

    return toolExecutionResult({
      conversationHistory,
      returnDirect: returnDirect ?? false,
    });
  }

  private async executeOne(
    toolCall: ToolCall,
    toolCallbacks: readonly ToolCallback[],
    toolContext: ToolContext,
  ): Promise<{ responseData: string; returnDirect: boolean }> {
    const toolName = toolCall.name;
    let toolInput = toolCall.arguments;
    if (!toolInput || toolInput.trim() === '') {
      toolInput = '{}';
    }

    const toolCallback =
      toolCallbacks.find((t) => t.toolDefinition.name === toolName) ??
      this.toolCallbackResolver.resolve(toolName);

    if (!toolCallback) {
      throw new Error(`No ToolCallback found for tool name: ${toolName}`);
    }

    const metadata = getToolMetadata(toolCallback);
    let responseData: string;
    try {
      responseData = await toolCallback.call(toolInput, toolContext);
    } catch (error) {
      if (error instanceof ToolExecutionException) {
        responseData = this.exceptionProcessor(error);
      } else {
        throw error;
      }
    }

    return {
      responseData: responseData ?? '',
      returnDirect: metadata.returnDirect,
    };
  }
}

function findAssistantWithToolCalls(chatResponse: ChatResponse): AssistantMessage | undefined {
  for (const gen of chatResponse.generations) {
    if (isAssistantMessage(gen.output) && gen.output.toolCalls.length > 0) {
      return gen.output;
    }
  }
  return undefined;
}

function buildToolContext(prompt: Prompt): ToolContext {
  const ctx = prompt.options?.toolContext;
  return new ToolContext(ctx ?? {});
}
