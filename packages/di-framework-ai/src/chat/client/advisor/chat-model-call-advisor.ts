import type { ChatModel } from '../../model/chat-model.ts';
import type { ChatClientRequest } from '../chat-client-request.ts';
import { chatClientResponse } from '../chat-client-response.ts';
import type { CallAdvisor, CallAdvisorChain } from './advisor.ts';
import { LOWEST_PRECEDENCE } from './ordered.ts';

/**
 * Terminal call advisor that invokes {@link ChatModel.call}.
 * Spring AI: {@code ChatModelCallAdvisor}.
 */
export class ChatModelCallAdvisor implements CallAdvisor {
  readonly name = 'ChatModelCallAdvisor';
  readonly order = LOWEST_PRECEDENCE;

  constructor(private readonly chatModel: ChatModel) {}

  async adviseCall(
    request: ChatClientRequest,
    _chain: CallAdvisorChain,
  ): Promise<ReturnType<typeof chatClientResponse>> {
    const chatResponse = await this.chatModel.call(request.prompt);
    return chatClientResponse(chatResponse, request.context);
  }

  static of(chatModel: ChatModel): ChatModelCallAdvisor {
    return new ChatModelCallAdvisor(chatModel);
  }
}
