import { beforeEach, describe, expect, test } from 'bun:test';
import { useContainer } from '@di-framework/core/container';
import { Component, Container as Injectable, Subscriber } from '@di-framework/core/decorators';
import {
  type AiChatResponseEvent,
  AiEvents,
  AiTokens,
  ChatClient,
  type ChatModel,
  configureAi,
  FakeChatModel,
  functionToolCallback,
  MessageWindowChatMemory,
  observationAdvisor,
  registerChatClient,
  registerChatModel,
  resolveChatClient,
  resolveChatModel,
  ScriptedChatModel,
  Tool,
  toolCall,
  toolCallbacksFromBean,
  toolCallResponse,
} from '../src/index.ts';

beforeEach(() => {
  useContainer().clear();
});

describe('registerChatModel / resolve', () => {
  test('registers model under string token and alias', () => {
    const model = new FakeChatModel('hello');
    registerChatModel(model, {
      aliases: [AiTokens.CHAT_MODEL_DEFAULT],
    });

    const c = useContainer();
    expect(c.resolve<ChatModel>(AiTokens.CHAT_MODEL)).toBe(model);
    expect(c.resolve<ChatModel>(AiTokens.CHAT_MODEL_DEFAULT)).toBe(model);
    expect(resolveChatModel().call).toBeTypeOf('function');
  });

  test('supports factory registration', async () => {
    registerChatModel(() => new FakeChatModel('from-factory'));
    const model = resolveChatModel();
    const client = ChatClient.create(model);
    expect(await client.prompt().user('x').call().content()).toBe('from-factory');
  });

  test('injects via @Component(token)', async () => {
    registerChatModel(new FakeChatModel('injected'));

    @Injectable()
    class Assistant {
      @Component(AiTokens.CHAT_MODEL)
      model!: ChatModel;

      async ask(q: string) {
        return ChatClient.create(this.model).prompt().user(q).call().content();
      }
    }

    const assistant = useContainer().resolve(Assistant);
    expect(await assistant.ask('hi')).toBe('injected');
  });
});

describe('configureAi auto-config', () => {
  test('registers ChatClient factory with default system', async () => {
    configureAi({
      chatModel: new FakeChatModel('ok'),
      defaultSystem: 'Be brief.',
    });

    const client = resolveChatClient();
    expect(client).toBeTruthy();
    expect(useContainer().resolve<ChatClient>(AiTokens.CHAT_CLIENT)).toBe(client);

    const content = await client.prompt().user('ping').call().content();
    expect(content).toBe('ok');
  });

  test('wires @Tool beans and tool-calling loop', async () => {
    @Injectable()
    class WeatherTools {
      @Tool({
        description: 'Get weather for a city',
        inputSchema: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
        },
      })
      getWeather({ city }: { city: string }) {
        return { temp: 68, city };
      }
    }

    const model = new ScriptedChatModel([
      {
        respond: (prompt) => {
          const tools = prompt.options?.toolCallbacks ?? [];
          expect(tools.some((t) => t.toolDefinition.name === 'getWeather')).toBe(true);
          return toolCallResponse([toolCall('c1', 'getWeather', { city: 'Yorktown' })]);
        },
      },
      { respond: '68F in Yorktown' },
    ]);

    configureAi({
      chatModel: model,
      toolBeans: [WeatherTools],
    });

    const tools = useContainer().resolve<unknown[]>(AiTokens.TOOL_CALLBACKS);
    expect(Array.isArray(tools)).toBe(true);
    expect(
      (tools as { toolDefinition: { name: string } }[]).map((t) => t.toolDefinition.name),
    ).toContain('getWeather');

    const answer = await resolveChatClient().prompt().user('Weather in Yorktown?').call().content();
    expect(answer).toBe('68F in Yorktown');
  });

  test('registers memory and ChatClient uses MessageChatMemoryAdvisor', async () => {
    const memory = MessageWindowChatMemory.builder().maxMessages(20).build();
    const model = new ScriptedChatModel([
      { respond: 'Hi Alice' },
      {
        respond: (p) => {
          const joined = p.messages.map((m) => m.text ?? '').join(' ');
          expect(joined).toContain('Alice');
          return 'Your name is Alice';
        },
      },
    ]);

    configureAi({
      chatModel: model,
      memory,
    });

    const client = resolveChatClient();
    const { CHAT_MEMORY_CONVERSATION_ID } = await import('../src/index.ts');
    await client
      .prompt()
      .user("Hi, I'm Alice")
      .advisorContext({ [CHAT_MEMORY_CONVERSATION_ID]: 'c1' })
      .call()
      .content();
    const second = await client
      .prompt()
      .user('What is my name?')
      .advisorContext({ [CHAT_MEMORY_CONVERSATION_ID]: 'c1' })
      .call()
      .content();
    expect(second).toBe('Your name is Alice');
  });
});

describe('@Tool decorator', () => {
  test('toolCallbacksFromBean binds methods', async () => {
    class LocalTools {
      @Tool({
        name: 'add',
        description: 'Add two numbers',
        inputSchema: {
          type: 'object',
          properties: {
            a: { type: 'number' },
            b: { type: 'number' },
          },
          required: ['a', 'b'],
        },
      })
      add({ a, b }: { a: number; b: number }) {
        return a + b;
      }
    }

    const callbacks = toolCallbacksFromBean(new LocalTools());
    expect(callbacks).toHaveLength(1);
    expect(callbacks[0]!.toolDefinition.name).toBe('add');
    const result = await callbacks[0]!.call(JSON.stringify({ a: 2, b: 3 }));
    expect(JSON.parse(result)).toBe(5);
  });
});

describe('ObservationAdvisor + @Subscriber', () => {
  test('emits redacted chat events without prompt text by default', async () => {
    const events: unknown[] = [];

    @Injectable()
    class AiAudit {
      @Subscriber(AiEvents.CHAT_REQUEST)
      onRequest(payload: unknown) {
        events.push(payload);
      }

      @Subscriber(AiEvents.CHAT_RESPONSE)
      onResponse(payload: unknown) {
        events.push(payload);
      }
    }

    useContainer().resolve(AiAudit);

    const model = new FakeChatModel('pong');
    const client = ChatClient.builder(model).defaultAdvisors(observationAdvisor()).build();

    await client.prompt().user('secret prompt text').call().content();

    expect(events.length).toBe(2);
    const req = events[0] as Record<string, unknown>;
    const res = events[1] as AiChatResponseEvent;
    expect(req.type).toBe(AiEvents.CHAT_REQUEST);
    expect(req.messageCount).toBe(1);
    expect(req.promptText).toBeUndefined();
    expect(res.type).toBe(AiEvents.CHAT_RESPONSE);
    expect(res.responseText).toBeUndefined();
    expect(res.durationMs).toBeGreaterThanOrEqual(0);
  });

  test('configureAi({ observation: true }) wires observer', async () => {
    const seen: string[] = [];

    @Injectable()
    class Sink {
      @Subscriber(AiEvents.CHAT_RESPONSE)
      onRes(payload: AiChatResponseEvent) {
        seen.push(payload.type);
      }
    }

    useContainer().resolve(Sink);

    configureAi({
      chatModel: new FakeChatModel('x'),
      observation: true,
    });

    await resolveChatClient().prompt().user('q').call().content();
    expect(seen).toEqual([AiEvents.CHAT_RESPONSE]);
  });
});

describe('registerChatClient manual', () => {
  test('registers prebuilt client', async () => {
    const model = new FakeChatModel('manual');
    const client = ChatClient.create(model);
    registerChatClient(client);
    expect(await resolveChatClient().prompt().user('a').call().content()).toBe('manual');
  });

  test('explicit tools still work alongside DI client', async () => {
    const weather = functionToolCallback({
      name: 'getWeather',
      call: () => ({ temp: 1 }),
    });
    configureAi({
      chatModel: new FakeChatModel('no-tools-path'),
      tools: [weather],
    });
    const registered = useContainer().resolve<{ toolDefinition: { name: string } }[]>(
      AiTokens.TOOL_CALLBACKS,
    );
    expect(registered[0]!.toolDefinition.name).toBe('getWeather');
  });
});
