/**
 * Errors raised while assembling or executing a semantic schema.
 */

/** Raised when the decorated object graph cannot be turned into a valid schema. */
export class SemanticSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SemanticSchemaError';
  }
}

/**
 * Raised when a bounded context reaches across a semantic boundary it does not own.
 *
 * Contexts may only reference or extend types from other contexts when those types
 * are explicitly declared with `@SemanticType({ boundary: true })`.
 */
export class SemanticBoundaryError extends SemanticSchemaError {
  constructor(message: string) {
    super(message);
    this.name = 'SemanticBoundaryError';
  }
}
