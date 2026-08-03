import { describe, expect, test } from 'bun:test';
import {
  ChatClient,
  ContextualQueryAugmenter,
  cosineSimilarity,
  evaluateFilterExpression,
  FakeChatModel,
  FakeEmbeddingModel,
  FilterExpressionBuilder,
  parseFilterExpression,
  query,
  RAG_DOCUMENT_CONTEXT,
  RecordingChatModel,
  RetrievalAugmentationAdvisor,
  SimpleVectorStore,
  searchRequest,
  textDocument,
  VectorStoreDocumentRetriever,
} from '../src/index.ts';

describe('FakeEmbeddingModel / cosine', () => {
  test('similar texts score higher than unrelated', () => {
    const model = new FakeEmbeddingModel({ dimensions: 64 });
    const a = model.embed('Yorktown Virginia historic town');
    const b = model.embed('Yorktown is a town in Virginia');
    const c = model.embed('quantum chromodynamics lattice');
    expect(cosineSimilarity(a, b)).toBeGreaterThan(cosineSimilarity(a, c));
  });
});

describe('Filter expressions', () => {
  const b = new FilterExpressionBuilder();

  test('builder EQ and AND', () => {
    const exp = b.and(b.eq('country', 'UK'), b.gte('year', 2020)).build();
    expect(evaluateFilterExpression(exp, { country: 'UK', year: 2021 })).toBe(true);
    expect(evaluateFilterExpression(exp, { country: 'UK', year: 2019 })).toBe(false);
    expect(evaluateFilterExpression(exp, { country: 'US', year: 2021 })).toBe(false);
  });

  test('IN / NIN', () => {
    const inExp = b.in('genre', 'comedy', 'drama').build();
    expect(evaluateFilterExpression(inExp, { genre: 'drama' })).toBe(true);
    expect(evaluateFilterExpression(inExp, { genre: 'horror' })).toBe(false);

    const ninExp = b.nin('city', 'Sofia', 'Plovdiv').build();
    expect(evaluateFilterExpression(ninExp, { city: 'Varna' })).toBe(true);
    expect(evaluateFilterExpression(ninExp, { city: 'Sofia' })).toBe(false);
  });

  test('ISNULL / NOT', () => {
    expect(evaluateFilterExpression(b.isNull('x').build(), {})).toBe(true);
    expect(evaluateFilterExpression(b.isNotNull('x').build(), { x: 1 })).toBe(true);
    expect(
      evaluateFilterExpression(b.not(b.eq('active', true)).build(), {
        active: false,
      }),
    ).toBe(true);
  });

  test('text parser', () => {
    const exp = parseFilterExpression("country == 'UK' && year >= 2020 && isActive == true");
    expect(
      evaluateFilterExpression(exp, {
        country: 'UK',
        year: 2020,
        isActive: true,
      }),
    ).toBe(true);
    expect(
      evaluateFilterExpression(exp, {
        country: 'UK',
        year: 2019,
        isActive: true,
      }),
    ).toBe(false);
  });

  test('text parser OR and grouping', () => {
    const exp = parseFilterExpression("(country == 'BG' || country == 'UK') AND year > 2000");
    expect(evaluateFilterExpression(exp, { country: 'BG', year: 2001 })).toBe(true);
    expect(evaluateFilterExpression(exp, { country: 'US', year: 2001 })).toBe(false);
  });
});

describe('SimpleVectorStore', () => {
  test('add and similarity search ranks relevant docs', async () => {
    const store = SimpleVectorStore.of(new FakeEmbeddingModel());
    await store.add([
      textDocument(
        'Yorktown is in Virginia near the Chesapeake.',
        {
          source: 'a',
        },
        'd1',
      ),
      textDocument('The Eiffel Tower is in Paris, France.', { source: 'b' }, 'd2'),
      textDocument('Mount Fuji is a volcano in Japan.', { source: 'c' }, 'd3'),
    ]);
    expect(store.size).toBe(3);

    const hits = await store.similaritySearch(
      searchRequest({ query: 'Where is Yorktown?', topK: 2 }),
    );
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.id).toBe('d1');
    expect(hits[0]?.score).toBeGreaterThan(0);
  });

  test('metadata filter restricts results', async () => {
    const store = SimpleVectorStore.of(new FakeEmbeddingModel());
    await store.add([
      textDocument('Cat fact one', { animal: 'cat' }, 'c1'),
      textDocument('Dog fact one', { animal: 'dog' }, 'd1'),
      textDocument('Cat fact two', { animal: 'cat' }, 'c2'),
    ]);

    const hits = await store.similaritySearch(
      searchRequest({
        query: 'animal facts',
        topK: 10,
        filterExpression: "animal == 'cat'",
      }),
    );
    expect(hits.every((h) => h.metadata.animal === 'cat')).toBe(true);
    expect(hits).toHaveLength(2);
  });

  test('delete by id and filter', async () => {
    const store = SimpleVectorStore.of(new FakeEmbeddingModel());
    await store.add([
      textDocument('one', { keep: false }, 'a'),
      textDocument('two', { keep: true }, 'b'),
    ]);
    await store.delete(['a']);
    expect(store.size).toBe(1);

    await store.add([textDocument('three', { keep: false }, 'c')]);
    await store.deleteByFilter!(new FilterExpressionBuilder().eq('keep', false).build());
    expect(store.size).toBe(1);
    const remaining = await store.similaritySearchQuery!('two');
    expect(remaining.some((d) => d.id === 'b')).toBe(true);
  });

  test('similarity threshold filters low scores', async () => {
    const store = SimpleVectorStore.of(new FakeEmbeddingModel());
    await store.add([textDocument('zzzz unrelated tokens', {}, 'z')]);
    const hits = await store.similaritySearch(
      searchRequest({
        query: 'Yorktown Virginia history',
        topK: 5,
        similarityThreshold: 0.99,
      }),
    );
    // Unrelated doc should not pass a very high threshold
    expect(hits.length).toBe(0);
  });
});

describe('ContextualQueryAugmenter', () => {
  test('injects context into prompt', () => {
    const augmenter = ContextualQueryAugmenter.builder();
    const augmented = augmenter.augment(query('Where is Yorktown?'), [
      textDocument('Yorktown is in Virginia.', {}, 'd1'),
    ]);
    expect(augmented.text).toContain('Yorktown is in Virginia.');
    expect(augmented.text).toContain('Where is Yorktown?');
  });

  test('empty context without allowEmptyContext uses empty template', () => {
    const augmenter = ContextualQueryAugmenter.builder({
      allowEmptyContext: false,
    });
    const augmented = augmenter.augment(query('q'), []);
    expect(augmented.text.toLowerCase()).toContain('knowledge');
  });

  test('allowEmptyContext returns original', () => {
    const augmenter = ContextualQueryAugmenter.builder({
      allowEmptyContext: true,
    });
    const original = query('q');
    expect(augmenter.augment(original, []).text).toBe('q');
  });
});

describe('RetrievalAugmentationAdvisor', () => {
  test('end-to-end RAG augments user message before model call', async () => {
    const store = SimpleVectorStore.of(new FakeEmbeddingModel());
    await store.add([
      textDocument('Yorktown is a historic town in Virginia.', { source: 'wiki' }, 'd1'),
      textDocument('Bananas are yellow fruit.', { source: 'wiki' }, 'd2'),
    ]);

    const model = new RecordingChatModel(new FakeChatModel('Yorktown is in Virginia.'));
    const rag = RetrievalAugmentationAdvisor.builder({
      documentRetriever: VectorStoreDocumentRetriever.builder({
        vectorStore: store,
        topK: 2,
      }),
    });

    const content = await ChatClient.builder(model)
      .defaultAdvisors(rag)
      .build()
      .prompt()
      .user('Where is Yorktown?')
      .call()
      .content();

    expect(content).toBe('Yorktown is in Virginia.');
    expect(model.calls).toHaveLength(1);
    const promptText = model.calls[0]!.getUserMessage().text ?? '';
    expect(promptText).toContain('Yorktown is a historic town in Virginia.');
    expect(promptText).toContain('Where is Yorktown?');
  });

  test('stores documents in context under RAG_DOCUMENT_CONTEXT', async () => {
    const store = SimpleVectorStore.of(new FakeEmbeddingModel());
    await store.add([textDocument('Ada Lovelace wrote early programs.', {}, 'd1')]);

    const client = ChatClient.builder(new FakeChatModel('Ada.'))
      .defaultAdvisors(
        RetrievalAugmentationAdvisor.builder({
          documentRetriever: VectorStoreDocumentRetriever.builder({
            vectorStore: store,
            topK: 1,
          }),
        }),
      )
      .build();

    const response = await client.prompt().user('Who is Ada?').call().chatClientResponse();

    const docs = response.context.get(RAG_DOCUMENT_CONTEXT) as { id: string }[] | undefined;
    expect(docs).toBeDefined();
    expect(docs!.length).toBeGreaterThan(0);
    expect(docs![0]?.id).toBe('d1');
    expect(response.chatResponse?.metadata[RAG_DOCUMENT_CONTEXT]).toBeDefined();
  });

  test('query transformer can rewrite the search text', async () => {
    const store = SimpleVectorStore.of(new FakeEmbeddingModel());
    await store.add([textDocument('The capital of France is Paris.', {}, 'd1')]);

    const model = new RecordingChatModel(new FakeChatModel('Paris.'));
    const rag = RetrievalAugmentationAdvisor.builder({
      documentRetriever: VectorStoreDocumentRetriever.builder({
        vectorStore: store,
        topK: 1,
      }),
      queryTransformers: [
        {
          transform: (q) =>
            query({
              text: 'capital of France Paris',
              history: q.history,
              context: q.context,
            }),
        },
      ],
    });

    await ChatClient.builder(model)
      .defaultAdvisors(rag)
      .build()
      .prompt()
      .user('???')
      .call()
      .content();

    const user = model.calls[0]!.getUserMessage().text ?? '';
    // Augmentation still uses original query text in template, with retrieved docs
    expect(user).toContain('The capital of France is Paris.');
  });
});
