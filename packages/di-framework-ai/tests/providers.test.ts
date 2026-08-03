import { describe, expect, test } from 'bun:test';
import {
  AnthropicChatModel,
  assistantMessage,
  ChatClient,
  type FetchLike,
  functionToolCallback,
  hasToolCalls,
  isAiError,
  OpenAiChatModel,
  Prompt,
  ScriptedChatModel,
  systemMessage,
  toAnthropicMessages,
  toOpenAiMessages,
  toolCall,
  toolResponse,
  toolResponseMessage,
  userMessage,
} from '../src/index.ts';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function sseResponse(events: string[]): Response {
  const body = events.map((e) => (e.startsWith('data:') ? e : `data: ${e}`)).join('\n\n') + '\n\n';
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

/** Shared ChatModel contract: call returns text, tools surface as toolCalls. */
function runChatModelContract(
  name: string,
  createTextModel: (fetch: FetchLike) => {
    call: (p: Prompt) => Promise<{ content: string; hasToolCalls: () => boolean }>;
  },
  createToolModel: (fetch: FetchLike) => {
    call: (p: Prompt) => Promise<{ hasToolCalls: () => boolean; content: string }>;
  },
  textFetch: FetchLike,
  toolFetch: FetchLike,
) {
  describe(`ChatModel contract: ${name}`, () => {
    test('call returns assistant text', async () => {
      const model = createTextModel(textFetch);
      const response = await model.call(new Prompt('Hello'));
      expect(response.content.length).toBeGreaterThan(0);
      expect(response.hasToolCalls()).toBe(false);
    });

    test('call maps tool calls', async () => {
      const model = createToolModel(toolFetch);
      const response = await model.call(new Prompt('Use a tool'));
      expect(response.hasToolCalls()).toBe(true);
    });
  });
}

describe('toOpenAiMessages', () => {
  test('maps system/user/assistant/tool', () => {
    const messages = toOpenAiMessages([
      systemMessage('sys'),
      userMessage('hi'),
      assistantMessage(null, {
        toolCalls: [toolCall('c1', 'getWeather', { city: 'Yorktown' })],
      }),
      toolResponseMessage([toolResponse('c1', 'getWeather', '{"temp":68}')]),
    ]);
    expect(messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'c1',
            type: 'function',
            function: {
              name: 'getWeather',
              arguments: '{"city":"Yorktown"}',
            },
          },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'c1',
        content: '{"temp":68}',
        name: 'getWeather',
      },
    ]);
  });
});

describe('toAnthropicMessages', () => {
  test('lifts system and maps tool results to user blocks', () => {
    const mapped = toAnthropicMessages([
      systemMessage('be helpful'),
      userMessage('weather?'),
      assistantMessage(null, {
        toolCalls: [toolCall('t1', 'getWeather', { city: 'Yorktown' })],
      }),
      toolResponseMessage([toolResponse('t1', 'getWeather', '{"temp":68}')]),
    ]);
    expect(mapped.system).toBe('be helpful');
    expect(mapped.messages).toHaveLength(3);
    expect(mapped.messages[0]).toEqual({ role: 'user', content: 'weather?' });
    expect(mapped.messages[1]!.role).toBe('assistant');
    expect(mapped.messages[2]!.role).toBe('user');
    const toolResult = mapped.messages[2]!.content;
    expect(Array.isArray(toolResult)).toBe(true);
    expect((toolResult as { type: string }[])[0]!.type).toBe('tool_result');
  });

  test('merges consecutive same-role messages', () => {
    const mapped = toAnthropicMessages([
      userMessage('a'),
      toolResponseMessage([toolResponse('x', 't', 'ok')]),
    ]);
    expect(mapped.messages).toHaveLength(1);
    expect(mapped.messages[0]!.role).toBe('user');
  });
});

describe('OpenAiChatModel', () => {
  test('sends chat completions request and maps response', async () => {
    let seenUrl = '';
    let seenAuth = '';
    let seenBody: Record<string, unknown> = {};

    const fetchImpl: FetchLike = async (url, init) => {
      seenUrl = String(url);
      seenAuth = String((init?.headers as Record<string, string>)?.Authorization ?? '');
      seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse({
        id: 'chatcmpl-1',
        model: 'gpt-4o-mini',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'Hello there' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      });
    };

    const model = new OpenAiChatModel({
      apiKey: 'sk-test',
      model: 'gpt-4o-mini',
      fetch: fetchImpl,
    });

    const response = await model.call(
      new Prompt([systemMessage('sys'), userMessage('hi')], {
        temperature: 0.2,
      }),
    );

    expect(seenUrl).toBe('https://api.openai.com/v1/chat/completions');
    expect(seenAuth).toBe('Bearer sk-test');
    expect(seenBody.model).toBe('gpt-4o-mini');
    expect(seenBody.temperature).toBe(0.2);
    expect(seenBody.stream).toBe(false);
    expect(response.content).toBe('Hello there');
    expect(response.metadata.id).toBe('chatcmpl-1');
    expect(response.metadata.usage?.totalTokens).toBe(8);
    expect(response.getResult()?.metadata.finishReason).toBe('stop');
  });

  test('maps tool calls and tools array', async () => {
    let seenBody: Record<string, unknown> = {};
    const weather = functionToolCallback({
      name: 'getWeather',
      description: 'weather',
      inputSchema: {
        type: 'object',
        properties: { city: { type: 'string' } },
        required: ['city'],
      },
      call: () => ({ temp: 1 }),
    });

    const fetchImpl: FetchLike = async (_url, init) => {
      seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse({
        id: 'chatcmpl-tools',
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: {
                    name: 'getWeather',
                    arguments: '{"city":"Yorktown"}',
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      });
    };

    const model = new OpenAiChatModel({ apiKey: 'sk', fetch: fetchImpl });
    const response = await model.call(new Prompt('weather?', { toolCallbacks: [weather] }));

    expect(Array.isArray(seenBody.tools)).toBe(true);
    expect(hasToolCalls(response.getResult()!.output)).toBe(true);
    expect(response.getResult()!.output.toolCalls[0]!.name).toBe('getWeather');
  });

  test('maps HTTP 401 to authentication AiError', async () => {
    const model = new OpenAiChatModel({
      apiKey: 'bad',
      fetch: async () => jsonResponse({ error: { message: 'Incorrect API key' } }, 401),
    });
    try {
      await model.call(new Prompt('hi'));
      expect.unreachable();
    } catch (e) {
      expect(isAiError(e)).toBe(true);
      if (isAiError(e)) {
        expect(e.code).toBe('authentication');
        expect(e.details.provider).toBe('openai');
        expect(e.message).toContain('Incorrect API key');
      }
    }
  });

  test('requires api key', async () => {
    const model = new OpenAiChatModel({
      apiKey: '',
      fetch: async () => jsonResponse({}),
    });
    await expect(model.call(new Prompt('hi'))).rejects.toMatchObject({
      code: 'authentication',
    });
  });

  test('streams SSE deltas', async () => {
    const fetchImpl: FetchLike = async () =>
      sseResponse([
        JSON.stringify({
          id: 's1',
          model: 'gpt-4o-mini',
          choices: [{ delta: { content: 'Hel' }, index: 0 }],
        }),
        JSON.stringify({
          id: 's1',
          choices: [{ delta: { content: 'lo' }, index: 0 }],
        }),
        JSON.stringify({
          id: 's1',
          choices: [{ delta: {}, finish_reason: 'stop', index: 0 }],
        }),
        '[DONE]',
      ]);

    const model = new OpenAiChatModel({ apiKey: 'sk', fetch: fetchImpl });
    const chunks: string[] = [];
    for await (const chunk of model.stream!(new Prompt('hi'))) {
      chunks.push(chunk.content);
    }
    expect(chunks.at(-1)).toBe('Hello');
  });

  test('honors AbortSignal', async () => {
    const controller = new AbortController();
    controller.abort();
    const model = new OpenAiChatModel({
      apiKey: 'sk',
      fetch: async () => jsonResponse({ choices: [] }),
    });
    await expect(model.call(new Prompt('hi', { signal: controller.signal }))).rejects.toMatchObject(
      { code: 'cancelled' },
    );
  });

  test('response_format from outputSchema', async () => {
    let seenBody: Record<string, unknown> = {};
    const model = new OpenAiChatModel({
      apiKey: 'sk',
      fetch: async (_u, init) => {
        seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse({
          choices: [{ message: { content: '{"a":1}' }, finish_reason: 'stop' }],
        });
      },
    });
    await model.call(
      new Prompt('x', {
        outputSchema: JSON.stringify({
          type: 'object',
          properties: { a: { type: 'number' } },
        }),
      }),
    );
    expect(seenBody.response_format).toMatchObject({ type: 'json_schema' });
  });
});

describe('AnthropicChatModel', () => {
  test('sends messages request and maps text response', async () => {
    let seenUrl = '';
    let seenHeaders: Record<string, string> = {};
    let seenBody: Record<string, unknown> = {};

    const fetchImpl: FetchLike = async (url, init) => {
      seenUrl = String(url);
      seenHeaders = init?.headers as Record<string, string>;
      seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse({
        id: 'msg_1',
        model: 'claude-sonnet-4-20250514',
        role: 'assistant',
        content: [{ type: 'text', text: 'Hi from Claude' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 4 },
      });
    };

    const model = new AnthropicChatModel({
      apiKey: 'ant-key',
      fetch: fetchImpl,
    });

    const response = await model.call(new Prompt([systemMessage('sys'), userMessage('hello')]));

    expect(seenUrl).toBe('https://api.anthropic.com/v1/messages');
    expect(seenHeaders['x-api-key']).toBe('ant-key');
    expect(seenHeaders['anthropic-version']).toBe('2023-06-01');
    expect(seenBody.system).toBe('sys');
    expect(seenBody.max_tokens).toBe(4096);
    expect(response.content).toBe('Hi from Claude');
    expect(response.getResult()?.metadata.finishReason).toBe('stop');
    expect(response.metadata.usage?.promptTokens).toBe(10);
  });

  test('maps tool_use blocks', async () => {
    const model = new AnthropicChatModel({
      apiKey: 'k',
      fetch: async () =>
        jsonResponse({
          content: [
            {
              type: 'tool_use',
              id: 'toolu_1',
              name: 'getWeather',
              input: { city: 'Yorktown' },
            },
          ],
          stop_reason: 'tool_use',
        }),
    });

    const response = await model.call(new Prompt('weather'));
    expect(response.hasToolCalls()).toBe(true);
    expect(response.getResult()!.output.toolCalls[0]).toMatchObject({
      id: 'toolu_1',
      name: 'getWeather',
    });
    expect(response.getResult()?.metadata.finishReason).toBe('tool_calls');
  });

  test('streams text deltas', async () => {
    const fetchImpl: FetchLike = async () =>
      sseResponse([
        JSON.stringify({
          type: 'message_start',
          message: {
            id: 'm1',
            model: 'claude',
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        }),
        JSON.stringify({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Hey' },
        }),
        JSON.stringify({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: '!' },
        }),
        JSON.stringify({
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: { output_tokens: 2 },
        }),
        JSON.stringify({ type: 'message_stop' }),
      ]);

    const model = new AnthropicChatModel({ apiKey: 'k', fetch: fetchImpl });
    let last = '';
    for await (const chunk of model.stream!(new Prompt('hi'))) {
      last = chunk.content;
    }
    expect(last).toBe('Hey!');
  });

  test('maps 429 rate limit', async () => {
    const model = new AnthropicChatModel({
      apiKey: 'k',
      fetch: async () => jsonResponse({ error: { message: 'rate limited' } }, 429),
    });
    await expect(model.call(new Prompt('x'))).rejects.toMatchObject({
      code: 'rate-limit',
      details: { retryable: true },
    });
  });
});

// Shared contract suite for both providers with mock transports.
runChatModelContract(
  'openai',
  (fetch) => new OpenAiChatModel({ apiKey: 'k', fetch }),
  (fetch) => new OpenAiChatModel({ apiKey: 'k', fetch }),
  async () =>
    jsonResponse({
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
    }),
  async () =>
    jsonResponse({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: 'c',
                type: 'function',
                function: { name: 't', arguments: '{}' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    }),
);

runChatModelContract(
  'anthropic',
  (fetch) => new AnthropicChatModel({ apiKey: 'k', fetch }),
  (fetch) => new AnthropicChatModel({ apiKey: 'k', fetch }),
  async () =>
    jsonResponse({
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
    }),
  async () =>
    jsonResponse({
      content: [{ type: 'tool_use', id: 'c', name: 't', input: {} }],
      stop_reason: 'tool_use',
    }),
);

describe('Providers + ChatClient tool loop (scripted remains primary path)', () => {
  test('OpenAI mock + ToolCallingAdvisor still works via ChatClient', async () => {
    let turn = 0;
    const fetchImpl: FetchLike = async () => {
      turn += 1;
      if (turn === 1) {
        return jsonResponse({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: 'call_w',
                    type: 'function',
                    function: {
                      name: 'getWeather',
                      arguments: '{"city":"Yorktown"}',
                    },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        });
      }
      return jsonResponse({
        choices: [
          {
            message: { content: '68F in Yorktown' },
            finish_reason: 'stop',
          },
        ],
      });
    };

    const weather = functionToolCallback({
      name: 'getWeather',
      description: 'Get weather',
      inputSchema: {
        type: 'object',
        properties: { city: { type: 'string' } },
        required: ['city'],
      },
      call: ({ city }: { city: string }) => ({ temp: 68, city }),
    });

    const client = ChatClient.create(new OpenAiChatModel({ apiKey: 'sk', fetch: fetchImpl }));

    const answer = await client
      .prompt()
      .user('What is the weather in Yorktown?')
      .tools(weather)
      .call()
      .content();

    expect(answer).toBe('68F in Yorktown');
    expect(turn).toBe(2);
  });

  test('contract: ScriptedChatModel still satisfies portable call API', async () => {
    const model = new ScriptedChatModel([{ respond: 'portable' }]);
    const response = await model.call(new Prompt('q'));
    expect(response.content).toBe('portable');
  });
});
