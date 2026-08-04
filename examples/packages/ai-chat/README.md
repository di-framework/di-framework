# AI chat + tools + RAG example

This example uses the annotation-first `@di-framework/ai` API:

- `@AiService` defines the assistant.
- `@ToolSet` and `@Tool` expose a domain tool.
- `@WithRag` attaches retrieval augmentation.
- `configureAi` wires the chat model, tool bean, and vector store through DI.

The test uses `ScriptedChatModel`, `FakeEmbeddingModel`, and `SimpleVectorStore`, so it runs without an API key. Replace the scripted model with an OpenAI-compatible or Anthropic model in an application that has provider credentials.
