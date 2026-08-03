import type { Media } from '../../content/media.ts';
import { systemMessage, userMessage } from '../messages/factories.ts';
import type { ChatMessage, Message } from '../messages/message.ts';
import type { ChatModel } from '../model/chat-model.ts';
import type { ChatResponse } from '../model/chat-response.ts';
import type { ChatOptions } from '../prompt/chat-options.ts';
import { mergeChatOptions } from '../prompt/chat-options.ts';
import { Prompt } from '../prompt/prompt.ts';
import {
  type Advisor,
  ChatModelCallAdvisor,
  ChatModelStreamAdvisor,
  DefaultAdvisorChain,
} from './advisor/index.ts';
import { type ChatClientRequest, chatClientRequest } from './chat-client-request.ts';
import type { ChatClientResponse } from './chat-client-response.ts';
import { renderTemplate } from './template.ts';

export interface ChatClientBuilderOptions {
  readonly defaultSystem?: string;
  readonly defaultUser?: string;
  readonly defaultOptions?: ChatOptions;
  readonly defaultAdvisors?: readonly Advisor[];
  readonly defaultContext?: Readonly<Record<string, unknown>>;
}

export interface ChatClient {
  prompt(): ChatClientRequestSpec;
  prompt(content: string): ChatClientRequestSpec;
  prompt(prompt: Prompt): ChatClientRequestSpec;
  mutate(): ChatClientBuilder;
}

export interface ChatClientBuilder {
  defaultSystem(text: string): ChatClientBuilder;
  defaultUser(text: string): ChatClientBuilder;
  defaultOptions(options: ChatOptions): ChatClientBuilder;
  defaultAdvisors(...advisors: Advisor[]): ChatClientBuilder;
  defaultContext(context: Readonly<Record<string, unknown>>): ChatClientBuilder;
  build(): ChatClient;
}

export interface CallResponseSpec {
  content(): Promise<string | undefined>;
  chatResponse(): Promise<ChatResponse | undefined>;
  chatClientResponse(): Promise<ChatClientResponse>;
}

export interface StreamResponseSpec {
  content(): AsyncIterable<string>;
  chatResponse(): AsyncIterable<ChatResponse>;
  chatClientResponse(): AsyncIterable<ChatClientResponse>;
}

export interface ChatClientRequestSpec {
  system(text: string): ChatClientRequestSpec;
  system(
    spec: (s: { text: string; params?: Record<string, unknown> }) => void,
  ): ChatClientRequestSpec;
  user(text: string): ChatClientRequestSpec;
  user(
    spec: (u: { text: string; params?: Record<string, unknown>; media?: readonly Media[] }) => void,
  ): ChatClientRequestSpec;
  messages(...messages: Message[]): ChatClientRequestSpec;
  messages(messages: readonly Message[]): ChatClientRequestSpec;
  options(options: ChatOptions): ChatClientRequestSpec;
  advisors(...advisors: Advisor[]): ChatClientRequestSpec;
  advisors(advisors: readonly Advisor[]): ChatClientRequestSpec;
  /** Merge values into the advisor context map. */
  advisorContext(context: Readonly<Record<string, unknown>>): ChatClientRequestSpec;
  call(): CallResponseSpec;
  stream(): StreamResponseSpec;
  /** Build the immutable request without executing (useful for tests). */
  toRequest(): ChatClientRequest;
}

class DefaultCallResponseSpec implements CallResponseSpec {
  constructor(
    private readonly request: ChatClientRequest,
    private readonly chain: DefaultAdvisorChain,
  ) {}

  async chatClientResponse(): Promise<ChatClientResponse> {
    return this.chain.nextCall(this.request);
  }

  async chatResponse(): Promise<ChatResponse | undefined> {
    return (await this.chatClientResponse()).chatResponse;
  }

  async content(): Promise<string | undefined> {
    const response = await this.chatResponse();
    if (!response?.getResult()) return undefined;
    return response.content;
  }
}

class DefaultStreamResponseSpec implements StreamResponseSpec {
  constructor(
    private readonly request: ChatClientRequest,
    private readonly chain: DefaultAdvisorChain,
  ) {}

  async *chatClientResponse(): AsyncIterable<ChatClientResponse> {
    yield* this.chain.nextStream(this.request);
  }

  async *chatResponse(): AsyncIterable<ChatResponse> {
    for await (const clientResponse of this.chatClientResponse()) {
      if (clientResponse.chatResponse) {
        yield clientResponse.chatResponse;
      }
    }
  }

  async *content(): AsyncIterable<string> {
    for await (const response of this.chatResponse()) {
      const text = response.content;
      if (text) yield text;
    }
  }
}

class DefaultChatClientRequestSpec implements ChatClientRequestSpec {
  private systemText: string | undefined;
  private systemParams: Record<string, unknown> = {};
  private userText: string | undefined;
  private userParams: Record<string, unknown> = {};
  private userMedia: readonly Media[] = [];
  private readonly messageList: ChatMessage[] = [];
  private optionsValue: ChatOptions | undefined;
  private readonly advisorList: Advisor[] = [];
  private readonly context: Map<string, unknown> = new Map();

  constructor(
    private readonly chatModel: ChatModel,
    private readonly defaults: ChatClientBuilderOptions,
  ) {
    this.systemText = defaults.defaultSystem;
    this.userText = defaults.defaultUser;
    this.optionsValue = defaults.defaultOptions
      ? { ...defaults.defaultOptions }
      : chatModel.options
        ? { ...chatModel.options }
        : undefined;
    if (defaults.defaultAdvisors) {
      this.advisorList.push(...defaults.defaultAdvisors);
    }
    if (defaults.defaultContext) {
      for (const [k, v] of Object.entries(defaults.defaultContext)) {
        this.context.set(k, v);
      }
    }
  }

  system(
    textOrSpec: string | ((s: { text: string; params?: Record<string, unknown> }) => void),
  ): ChatClientRequestSpec {
    if (typeof textOrSpec === 'string') {
      this.systemText = textOrSpec;
      return this;
    }
    const bag: { text: string; params?: Record<string, unknown> } = {
      text: this.systemText ?? '',
    };
    textOrSpec(bag);
    this.systemText = bag.text;
    if (bag.params) Object.assign(this.systemParams, bag.params);
    return this;
  }

  user(
    textOrSpec:
      | string
      | ((u: { text: string; params?: Record<string, unknown>; media?: readonly Media[] }) => void),
  ): ChatClientRequestSpec {
    if (typeof textOrSpec === 'string') {
      this.userText = textOrSpec;
      return this;
    }
    const bag: {
      text: string;
      params?: Record<string, unknown>;
      media?: readonly Media[];
    } = {
      text: this.userText ?? '',
    };
    textOrSpec(bag);
    this.userText = bag.text;
    if (bag.params) Object.assign(this.userParams, bag.params);
    if (bag.media) this.userMedia = bag.media;
    return this;
  }

  messages(...args: Array<Message | readonly Message[]>): ChatClientRequestSpec {
    for (const arg of args) {
      if (Array.isArray(arg)) {
        this.messageList.push(...(arg as ChatMessage[]));
      } else {
        this.messageList.push(arg as ChatMessage);
      }
    }
    return this;
  }

  options(options: ChatOptions): ChatClientRequestSpec {
    this.optionsValue = mergeChatOptions(this.optionsValue, options);
    return this;
  }

  advisors(...args: Array<Advisor | readonly Advisor[]>): ChatClientRequestSpec {
    for (const arg of args) {
      if (Array.isArray(arg)) {
        this.advisorList.push(...arg);
      } else {
        this.advisorList.push(arg as Advisor);
      }
    }
    return this;
  }

  advisorContext(context: Readonly<Record<string, unknown>>): ChatClientRequestSpec {
    for (const [k, v] of Object.entries(context)) {
      this.context.set(k, v);
    }
    return this;
  }

  toRequest(): ChatClientRequest {
    const messages: ChatMessage[] = [];

    if (this.systemText != null && this.systemText !== '') {
      const text =
        Object.keys(this.systemParams).length > 0
          ? renderTemplate(this.systemText, this.systemParams)
          : this.systemText;
      messages.push(systemMessage(text));
    }

    messages.push(...this.messageList);

    if (this.userText != null && this.userText !== '') {
      const text =
        Object.keys(this.userParams).length > 0
          ? renderTemplate(this.userText, this.userParams)
          : this.userText;
      messages.push(
        userMessage(text, {
          media: this.userMedia,
        }),
      );
    }

    const modelDefaults = this.chatModel.options;
    const options = mergeChatOptions(modelDefaults, this.optionsValue);
    const prompt = new Prompt(messages, options);
    return chatClientRequest(prompt, this.context);
  }

  call(): CallResponseSpec {
    const request = this.toRequest();
    const chain = DefaultAdvisorChain.of([
      ...this.advisorList,
      ChatModelCallAdvisor.of(this.chatModel),
    ]);
    return new DefaultCallResponseSpec(request, chain);
  }

  stream(): StreamResponseSpec {
    const request = this.toRequest();
    const chain = DefaultAdvisorChain.of([
      ...this.advisorList,
      ChatModelStreamAdvisor.of(this.chatModel),
    ]);
    return new DefaultStreamResponseSpec(request, chain);
  }
}

class DefaultChatClient implements ChatClient {
  constructor(
    private readonly chatModel: ChatModel,
    private readonly defaults: ChatClientBuilderOptions = {},
  ) {}

  prompt(): ChatClientRequestSpec;
  prompt(content: string): ChatClientRequestSpec;
  prompt(prompt: Prompt): ChatClientRequestSpec;
  prompt(input?: string | Prompt): ChatClientRequestSpec {
    const spec = new DefaultChatClientRequestSpec(this.chatModel, this.defaults);
    if (input === undefined) return spec;
    if (typeof input === 'string') {
      return spec.user(input);
    }
    return spec.messages(input.messages).options(input.options ?? {});
  }

  mutate(): ChatClientBuilder {
    return new DefaultChatClientBuilder(this.chatModel, { ...this.defaults });
  }
}

class DefaultChatClientBuilder implements ChatClientBuilder {
  private options: ChatClientBuilderOptions;

  constructor(
    private readonly chatModel: ChatModel,
    options: ChatClientBuilderOptions = {},
  ) {
    this.options = {
      ...options,
      defaultAdvisors: options.defaultAdvisors ? [...options.defaultAdvisors] : [],
      defaultContext: options.defaultContext ? { ...options.defaultContext } : {},
      defaultOptions: options.defaultOptions ? { ...options.defaultOptions } : undefined,
    };
  }

  defaultSystem(text: string): ChatClientBuilder {
    this.options = { ...this.options, defaultSystem: text };
    return this;
  }

  defaultUser(text: string): ChatClientBuilder {
    this.options = { ...this.options, defaultUser: text };
    return this;
  }

  defaultOptions(options: ChatOptions): ChatClientBuilder {
    this.options = {
      ...this.options,
      defaultOptions: mergeChatOptions(this.options.defaultOptions, options),
    };
    return this;
  }

  defaultAdvisors(...advisors: Advisor[]): ChatClientBuilder {
    const existing = this.options.defaultAdvisors ?? [];
    this.options = {
      ...this.options,
      defaultAdvisors: [...existing, ...advisors],
    };
    return this;
  }

  defaultContext(context: Readonly<Record<string, unknown>>): ChatClientBuilder {
    this.options = {
      ...this.options,
      defaultContext: { ...this.options.defaultContext, ...context },
    };
    return this;
  }

  build(): ChatClient {
    return new DefaultChatClient(this.chatModel, this.options);
  }
}

/**
 * Spring AI-style factory helpers for {@link ChatClient}.
 */
export const ChatClient = {
  create(chatModel: ChatModel): ChatClient {
    return new DefaultChatClient(chatModel);
  },

  builder(chatModel: ChatModel): ChatClientBuilder {
    return new DefaultChatClientBuilder(chatModel);
  },
};
