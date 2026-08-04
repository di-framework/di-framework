import {
  AiService,
  ChatClient,
  chatToolLoopGraph,
  configureAi,
  FakeEmbeddingModel,
  functionToolCallback,
  GRAPH_FINISH,
  GRAPH_START,
  GraphWorkflow,
  IndexedDocument,
  resolveAiService,
  ScriptedChatModel,
  SimpleVectorStore,
  Tool,
  ToolSet,
  toolCall,
  toolCallResponse,
  UserMessageAnn,
  WithRag,
} from '@di-framework/ai';
import { Container } from '@di-framework/core/decorators';

@ToolSet()
@Container()
export class ProductTools {
  @Tool({
    description: 'Look up the support policy for a product.',
    inputSchema: {
      type: 'object',
      properties: { product: { type: 'string' } },
      required: ['product'],
    },
  })
  supportPolicy({ product }: { product: string }): string {
    return `${product}: standard support is available Monday through Friday.`;
  }
}

@IndexedDocument({
  text: 'The Acme Widget includes a two-year warranty and weekday email support.',
  metadata: { source: 'example-catalog' },
})
@WithRag({ topK: 1 })
@AiService({ tools: [ProductTools] })
export class SupportAssistant {
  ask(@UserMessageAnn() _question: string): Promise<string> {
    throw new Error('The annotation proxy supplies this method at runtime.');
  }
}

/** Run the complete no-credentials example path. */
export async function runExample(): Promise<string> {
  const vectorStore = SimpleVectorStore.of(new FakeEmbeddingModel());
  await vectorStore.add([
    {
      id: 'acme-widget',
      text: 'The Acme Widget includes a two-year warranty and weekday email support.',
      media: null,
      metadata: { source: 'example-catalog' },
      score: null,
    },
  ]);

  const model = new ScriptedChatModel([
    {
      respond: () =>
        toolCallResponse([toolCall('support-1', 'supportPolicy', { product: 'Acme Widget' })]),
    },
    { respond: 'The Acme Widget has a two-year warranty and weekday support.' },
  ]);

  configureAi({
    chatModel: model,
    toolBeans: [ProductTools],
    vectorStore,
    scanAnnotations: true,
  });

  return resolveAiService(SupportAssistant).ask('What support does the Acme Widget have?');
}

/**
 * Graph workflow example: classify → specialist branch, plus a tool-loop subgraph.
 * No live credentials — uses {@link ScriptedChatModel}.
 */
export async function runGraphExample(): Promise<{
  routed: string;
  toolLoop: string;
  path: readonly string[];
}> {
  const routeGraph = GraphWorkflow.builder<string, string>('support-route')
    .node('classify', (text: string) => {
      const lower = text.toLowerCase();
      if (lower.includes('refund') || lower.includes('charge')) return 'billing';
      if (lower.includes('crash') || lower.includes('bug')) return 'technical';
      return 'general';
    })
    .node('billing', () => 'Billing specialist: refund window is 30 days.')
    .node('technical', () => 'Technical specialist: please share logs.')
    .node('general', () => 'General support: how can we help?')
    .edge(GRAPH_START, 'classify')
    .edge('classify', 'billing', { when: (r: string) => r === 'billing' })
    .edge('classify', 'technical', { when: (r: string) => r === 'technical' })
    .edge('classify', 'general', { when: (r: string) => r === 'general' })
    .edge('billing', GRAPH_FINISH)
    .edge('technical', GRAPH_FINISH)
    .edge('general', GRAPH_FINISH)
    .build();

  const routed = await routeGraph.run('I was charged twice for my order');

  const supportTool = functionToolCallback({
    name: 'supportPolicy',
    description: 'Look up support policy',
    inputSchema: {
      type: 'object',
      properties: { product: { type: 'string' } },
      required: ['product'],
    },
    call: ({ product }: { product: string }) =>
      `${product}: standard support is available Monday through Friday.`,
  });

  const model = new ScriptedChatModel([
    {
      respond: () =>
        toolCallResponse([toolCall('t1', 'supportPolicy', { product: 'Acme Widget' })]),
    },
    { respond: 'Acme Widget support is weekday email only.' },
  ]);

  const toolGraph = chatToolLoopGraph({
    chatClient: ChatClient.create(model),
    tools: [supportTool],
    system: 'Answer support questions using tools.',
  });
  const toolLoop = await toolGraph.run({ message: 'What support does Acme Widget have?' });

  return {
    routed: routed.output,
    toolLoop: toolLoop.output.content,
    path: routed.path,
  };
}

if (import.meta.main) {
  console.log(await runExample());
  console.log(await runGraphExample());
}
