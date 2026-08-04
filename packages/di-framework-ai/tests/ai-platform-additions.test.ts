import { describe, expect, test } from 'bun:test';
import type { CallAdvisorChain } from '../src/chat/client/advisor/advisor.ts';
import { chatClientRequest } from '../src/chat/client/chat-client-request.ts';
import { chatClientResponse } from '../src/chat/client/chat-client-response.ts';
import {
  createMcpToolServer,
  document,
  functionToolCallback,
  htmlDocumentLoader,
  media,
  parseStandardSchema,
  pdfDocumentLoader,
  RetryAdvisor,
  StandardSchemaOutputConverter,
  textDocumentLoader,
  toAnthropicMessages,
  toOpenAiMessages,
  userMessage,
} from '../src/index.ts';

describe('AI platform additions', () => {
  test('validates Standard Schema and converter output', async () => {
    const schema = {
      '~standard': {
        version: 1 as const,
        vendor: 'test',
        validate: (v: unknown) =>
          typeof v === 'object' && v !== null
            ? (v as { ok: boolean })
            : { issues: [{ message: 'object expected' }] },
      },
    };
    expect(await parseStandardSchema(schema, { ok: true })).toEqual({ ok: true });
    const converter = new StandardSchemaOutputConverter({ schema });
    expect(await converter.convertAsync('{"ok":true}')).toEqual({ ok: true });
    await expect(converter.convertAsync('null')).rejects.toThrow('object expected');
  });

  test('retries failed calls deterministically', async () => {
    let calls = 0;
    const chain: CallAdvisorChain = {
      callAdvisors: [],
      async nextCall() {
        calls++;
        if (calls < 3) throw { details: { retryable: true } };
        return chatClientResponse(undefined);
      },
    };
    const result = await new RetryAdvisor({ maxAttempts: 3, backoffMs: 0 }).adviseCall(
      chatClientRequest({} as never),
      chain,
    );
    expect(result.chatResponse).toBeUndefined();
    expect(calls).toBe(3);
  });

  test('maps multimodal content for both providers', () => {
    const msg = userMessage('describe', { media: [media('image/png', 'aGVsbG8=')] });
    const openai = toOpenAiMessages([msg]);
    const openAiMessage = openai[0];
    expect(openAiMessage).toBeDefined();
    expect(openAiMessage?.content).toEqual([
      { type: 'text', text: 'describe' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } },
    ]);
    const anthropic = toAnthropicMessages([msg]);
    const anthropicMessage = anthropic.messages[0];
    expect(anthropicMessage).toBeDefined();
    expect(anthropicMessage?.content).toHaveLength(2);
  });

  test('serves local tools through MCP surface', async () => {
    const server = createMcpToolServer({
      tools: [
        functionToolCallback({
          name: 'add',
          inputSchema: { type: 'object' },
          call: (input: { a: number }) => input.a + 1,
        }),
      ],
    });
    expect(server.listTools()[0]?.name).toBe('add');
    expect(await server.callTool('add', { a: 2 })).toMatchObject({ content: [{ text: '3' }] });
    expect((await server.callTool('missing')).isError).toBe(true);
  });

  test('loads text, HTML, and injected PDF text', async () => {
    expect((await textDocumentLoader().load(new TextEncoder().encode('hello')))[0]?.text).toBe(
      'hello',
    );
    expect((await htmlDocumentLoader().load('<h1>Hello</h1><script>x</script>'))[0]?.text).toBe(
      'Hello',
    );
    expect((await pdfDocumentLoader(() => 'pdf text').load(new Uint8Array([1])))[0]?.text).toBe(
      'pdf text',
    );
    expect(document({ text: 'x' }).metadata).toEqual({});
  });
});
