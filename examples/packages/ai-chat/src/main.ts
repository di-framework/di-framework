import {
  AiService,
  configureAi,
  FakeEmbeddingModel,
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

if (import.meta.main) {
  console.log(await runExample());
}
