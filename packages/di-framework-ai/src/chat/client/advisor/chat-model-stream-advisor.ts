import { AiError } from '../../../model/errors.ts';
import type { ChatModel } from '../../model/chat-model.ts';
import type { ChatClientRequest } from '../chat-client-request.ts';
import { chatClientResponse } from '../chat-client-response.ts';
import type { StreamAdvisor, StreamAdvisorChain } from './advisor.ts';
import { LOWEST_PRECEDENCE } from './ordered.ts';

/**
 * Terminal stream advisor that invokes {@link ChatModel.stream}.
 * Spring AI: {@code ChatModelStreamAdvisor}.
 */
export class ChatModelStreamAdvisor implements StreamAdvisor {
  readonly name = 'ChatModelStreamAdvisor';
  readonly order = LOWEST_PRECEDENCE;

  constructor(private readonly chatModel: ChatModel) {}

  async *adviseStream(
    request: ChatClientRequest,
    _chain: StreamAdvisorChain,
  ): AsyncIterable<ReturnType<typeof chatClientResponse>> {
    if (!this.chatModel.stream) {
      throw new AiError(`ChatModel does not support streaming`, 'invalid-request', {
        model: this.chatModel.options?.model,
      });
    }
    for await (const chatResponse of this.chatModel.stream(request.prompt)) {
      yield chatClientResponse(chatResponse, request.context);
    }
  }

  static of(chatModel: ChatModel): ChatModelStreamAdvisor {
    return new ChatModelStreamAdvisor(chatModel);
  }
}
