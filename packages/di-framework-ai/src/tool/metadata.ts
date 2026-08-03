/**
 * Metadata about tool specification and execution.
 * Spring AI: {@code ToolMetadata}.
 */
export interface ToolMetadata {
  /**
   * When true, tool results are returned directly to the client
   * instead of being fed back to the model.
   */
  readonly returnDirect: boolean;
}

export function toolMetadata(partial: { returnDirect?: boolean } = {}): ToolMetadata {
  return {
    returnDirect: partial.returnDirect ?? false,
  };
}

export const DEFAULT_TOOL_METADATA: ToolMetadata = Object.freeze({
  returnDirect: false,
});
