import { beforeEach, describe, expect, test } from 'bun:test';
import { useContainer } from '@di-framework/core/container';
import { Container as Injectable } from '@di-framework/core/decorators';
import {
  Agent,
  AiService,
  AiTokens,
  ChatAgent,
  clearAnnotatedTypes,
  configureAi,
  FakeChatModel,
  MemoryId,
  MessageWindowChatMemory,
  processAiAnnotations,
  resolveAiService,
  resolveAnnotatedAgent,
  resolveChatClientBuilder,
  ScriptedChatModel,
  SystemMessageAnn,
  Tool,
  ToolParam,
  ToolSet,
  toolCall,
  toolCallResponse,
  UserMessageAnn,
  WithMemory,
} from '../../src/index.ts';

beforeEach(() => {
  useContainer().clear();
  clearAnnotatedTypes();
});

describe('prototype ChatClient.Builder', () => {
  test('configureAi registers distinct builders per resolve', () => {
    configureAi({
      chatModel: new FakeChatModel('ok'),
      defaultSystem: 'base',
      scanAnnotations: false,
    });

    const a = resolveChatClientBuilder();
    const b = resolveChatClientBuilder();
    expect(a).not.toBe(b);

    const clientA = a.defaultSystem('A').build();
    const clientB = b.defaultSystem('B').build();
    expect(clientA).not.toBe(clientB);
  });
});

describe('@AiService', () => {
  test('proxy invokes ChatClient with system + user message', async () => {
    @AiService()
    class Friend {
      @SystemMessageAnn('You are a good friend. Answer using slang.')
      chat(@UserMessageAnn() _message: string): Promise<string> {
        throw new Error('AiService proxy should override this method');
      }
    }

    configureAi({
      chatModel: new FakeChatModel('yo whats up'),
      scanAnnotations: true,
    });

    const friend = resolveAiService(Friend);
    expect(await friend.chat('hello')).toBe('yo whats up');
  });

  test('wires @Tool beans declared on @AiService', async () => {
    @ToolSet()
    @Injectable()
    class LegalTools {
      @Tool({
        description: 'Returns last PRIVACY update',
        inputSchema: { type: 'object', properties: {} },
      })
      lastUpdatePrivacy(@ToolParam() _x?: string) {
        return '2013-03-09';
      }
    }

    @AiService({ tools: [LegalTools] })
    class CompanyBot {
      @SystemMessageAnn('You are a company policy bot.')
      ask(@UserMessageAnn() _question: string): Promise<string> {
        throw new Error('AiService proxy should override this method');
      }
    }

    const model = new ScriptedChatModel([
      {
        respond: (prompt) => {
          const tools = prompt.options?.toolCallbacks ?? [];
          expect(tools.some((t) => t.toolDefinition.name === 'lastUpdatePrivacy')).toBe(true);
          return toolCallResponse([toolCall('c1', 'lastUpdatePrivacy', {})]);
        },
      },
      { respond: 'Privacy was updated 2013-03-09' },
    ]);

    configureAi({
      chatModel: model,
      toolBeans: [LegalTools],
      scanAnnotations: true,
    });

    const bot = resolveAiService(CompanyBot);
    expect(await bot.ask('When was privacy updated?')).toBe('Privacy was updated 2013-03-09');
  });
});

describe('@Agent', () => {
  test('registers ChatAgent resolvable by class', async () => {
    @ToolSet()
    @Injectable()
    class WeatherTools {
      @Tool({
        description: 'Get weather',
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

    @Agent({
      system: 'You help with weather.',
      tools: [WeatherTools],
    })
    class SupportAgent {}

    const model = new ScriptedChatModel([
      {
        respond: () => toolCallResponse([toolCall('c1', 'getWeather', { city: 'Yorktown' })]),
      },
      { respond: '68F in Yorktown' },
    ]);

    configureAi({
      chatModel: model,
      toolBeans: [WeatherTools],
      scanAnnotations: true,
    });

    const agent = resolveAnnotatedAgent(SupportAgent);
    expect(agent).toBeInstanceOf(ChatAgent);
    const { content } = await agent.chat('Weather in Yorktown?');
    expect(content).toBe('68F in Yorktown');
  });

  test('ChatAgent.fromBuilder uses injected prototype builder', async () => {
    @Injectable()
    class WeatherTools {
      @Tool({
        description: 'Get weather',
        inputSchema: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
        },
      })
      getWeather({ city }: { city: string }) {
        return { temp: 72, city };
      }
    }

    const model = new ScriptedChatModel([
      {
        respond: () => toolCallResponse([toolCall('c1', 'getWeather', { city: 'Yorktown' })]),
      },
      { respond: '72F' },
    ]);

    // Tools are already on the prototype builder via toolBeans.
    configureAi({ chatModel: model, toolBeans: [WeatherTools], scanAnnotations: false });

    const agent = ChatAgent.fromBuilder(resolveChatClientBuilder())
      .system('Weather helper')
      .build();

    expect((await agent.chat('weather?')).content).toBe('72F');
  });
});

describe('@WithMemory + @MemoryId', () => {
  test('AiService passes conversation id to memory advisor', async () => {
    @AiService()
    @WithMemory()
    class RememberingBot {
      @SystemMessageAnn('Remember the user.')
      talk(@UserMessageAnn() _message: string, @MemoryId() _sessionId: string): Promise<string> {
        throw new Error('AiService proxy should override this method');
      }
    }

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
      scanAnnotations: true,
    });

    processAiAnnotations();

    const bot = resolveAiService(RememberingBot);
    await bot.talk("Hi, I'm Alice", 's1');
    expect(await bot.talk('What is my name?', 's1')).toBe('Your name is Alice');
  });
});

describe('AiTokens.CHAT_AGENT via configureAi', () => {
  test('registers default agent when agent: true', async () => {
    configureAi({
      chatModel: new FakeChatModel('agent-hi'),
      agent: true,
      scanAnnotations: false,
    });

    const agent = useContainer().resolve<ChatAgent>(AiTokens.CHAT_AGENT);
    expect((await agent.chat('hi')).content).toBe('agent-hi');
  });
});
