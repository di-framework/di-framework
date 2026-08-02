/**
 * Scalar references.
 *
 * TypeScript types are erased at runtime and this package deliberately avoids
 * `reflect-metadata` (matching the core container), so scalars are named with
 * small runtime markers instead of being inferred from type annotations.
 *
 * @example
 * `@Field(() => ID) id!: string;`
 * `@Field(() => Int) count(): number { ... }`
 */

/** A reference to a named GraphQL scalar. */
export class ScalarRef {
  constructor(public readonly scalarName: string) {}

  toString(): string {
    return this.scalarName;
  }
}

export const ID = new ScalarRef('ID');
export const Int = new ScalarRef('Int');
export const Float = new ScalarRef('Float');
export const Str = new ScalarRef('String');
export const Bool = new ScalarRef('Boolean');

/** ISO-8601 date-time scalar, serialized from `Date` or `string`. */
export const DateTime = new ScalarRef('DateTime');

/** Arbitrary JSON scalar. Escape hatch — prefer real semantic types. */
export const Json = new ScalarRef('JSON');

/** Scalars that GraphQL defines for us. */
export const SPEC_SCALARS = new Set(['ID', 'String', 'Int', 'Float', 'Boolean']);

/** Scalars this package defines, emitted into the schema only when used. */
export const CUSTOM_SCALARS = new Set(['DateTime', 'JSON']);

export function isScalarName(name: string): boolean {
  return SPEC_SCALARS.has(name) || CUSTOM_SCALARS.has(name);
}

/**
 * Map the handful of built-in JS constructors that have an obvious GraphQL
 * counterpart, so `@Field(() => String)` reads naturally.
 *
 * `Number` maps to `Float`; use `Int` explicitly when you mean an integer.
 */
export function scalarNameForConstructor(value: unknown): string | undefined {
  if (value === String) return 'String';
  if (value === Number) return 'Float';
  if (value === Boolean) return 'Boolean';
  if (value === Date) return 'DateTime';
  return undefined;
}
