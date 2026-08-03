/**
 * Portable chat options, aligned with Spring AI {@code ChatOptions}.
 *
 * Provider-specific options belong in dedicated option types that extend
 * this shape, or in {@link ChatOptions.providerOptions}.
 */
export interface ChatOptions {
  readonly model?: string;
  readonly temperature?: number;
  readonly topP?: number;
  readonly topK?: number;
  readonly frequencyPenalty?: number;
  readonly presencePenalty?: number;
  readonly maxTokens?: number;
  readonly stopSequences?: readonly string[];

  /**
   * TypeScript-native cancellation. Spring uses Reactor/subscription cancellation;
   * we surface {@link AbortSignal} here so providers and the client share one path.
   */
  readonly signal?: AbortSignal;

  /**
   * Escape hatch for provider-specific features.
   * Core portable code must not interpret these values.
   */
  readonly providerOptions?: Readonly<Record<string, unknown>>;
}

export function chatOptions(partial: ChatOptions = {}): ChatOptions {
  return { ...partial };
}

export function mergeChatOptions(
  base?: ChatOptions | null,
  override?: ChatOptions | null,
): ChatOptions | undefined {
  if (!base && !override) return undefined;
  if (!base) return override ?? undefined;
  if (!override) return base;
  return {
    ...base,
    ...override,
    stopSequences: override.stopSequences ?? base.stopSequences,
    providerOptions: {
      ...base.providerOptions,
      ...override.providerOptions,
    },
    signal: override.signal ?? base.signal,
  };
}
