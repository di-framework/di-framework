import type { ChatClientRequest } from '../chat-client-request.ts';
import type { ChatClientResponse } from '../chat-client-response.ts';
import {
  type Advisor,
  type CallAdvisor,
  type CallAdvisorChain,
  isCallAdvisor,
  isStreamAdvisor,
  type StreamAdvisor,
  type StreamAdvisorChain,
} from './advisor.ts';
import { compareOrder } from './ordered.ts';

/**
 * Ordered advisor chain, aligned with Spring AI {@code DefaultAroundAdvisorChain}.
 *
 * Advisors are sorted by ascending {@link Advisor.order}. The first advisor
 * receives the request; each calls {@code chain.nextCall/nextStream} to continue.
 * Terminal advisors ({@code ChatModelCallAdvisor}) do not call next.
 */
export class DefaultAdvisorChain implements CallAdvisorChain, StreamAdvisorChain {
  readonly callAdvisors: readonly CallAdvisor[];
  readonly streamAdvisors: readonly StreamAdvisor[];
  private readonly callIndex: number;
  private readonly streamIndex: number;

  private constructor(
    callAdvisors: readonly CallAdvisor[],
    streamAdvisors: readonly StreamAdvisor[],
    callIndex = 0,
    streamIndex = 0,
  ) {
    this.callAdvisors = callAdvisors;
    this.streamAdvisors = streamAdvisors;
    this.callIndex = callIndex;
    this.streamIndex = streamIndex;
  }

  static of(advisors: readonly Advisor[]): DefaultAdvisorChain {
    const callAdvisors = advisors.filter(isCallAdvisor).slice().sort(compareOrder);
    const streamAdvisors = advisors.filter(isStreamAdvisor).slice().sort(compareOrder);
    return new DefaultAdvisorChain(callAdvisors, streamAdvisors);
  }

  nextCall(request: ChatClientRequest): Promise<ChatClientResponse> {
    if (this.callIndex >= this.callAdvisors.length) {
      return Promise.reject(new Error('No CallAdvisors available to execute'));
    }
    const advisor = this.callAdvisors[this.callIndex]!;
    const next = new DefaultAdvisorChain(
      this.callAdvisors,
      this.streamAdvisors,
      this.callIndex + 1,
      this.streamIndex,
    );
    return advisor.adviseCall(request, next);
  }

  async *nextStream(request: ChatClientRequest): AsyncIterable<ChatClientResponse> {
    if (this.streamIndex >= this.streamAdvisors.length) {
      throw new Error('No StreamAdvisors available to execute');
    }
    const advisor = this.streamAdvisors[this.streamIndex]!;
    const next = new DefaultAdvisorChain(
      this.callAdvisors,
      this.streamAdvisors,
      this.callIndex,
      this.streamIndex + 1,
    );
    yield* advisor.adviseStream(request, next);
  }
}
