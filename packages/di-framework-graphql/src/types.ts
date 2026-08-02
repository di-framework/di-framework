/**
 * Type model for the semantic schema.
 *
 * Decorators record *declarations* (what the author wrote). `buildTypeGraph()`
 * turns those declarations into a resolved, validated {@link TypeGraph} which is
 * the single source for both SDL printing and executable schema construction.
 */

import type { ScalarRef } from './scalars.ts';

export type Ctor<T = any> = new (...args: any[]) => T;

/** An enum declared with `registerEnum()`. */
export type EnumObject = Record<string, string | number>;

/**
 * Anything usable as a type reference in a decorator:
 * a scalar marker (`ID`, `Int`), a decorated class, a registered enum object,
 * or a single-element array denoting a list (`[Order]`).
 */
export type TypeInput = ScalarRef | Ctor | EnumObject | readonly TypeInput[];

/** Lazy type reference — required for types that are declared later in the file. */
export type TypeThunk = () => TypeInput;

export type TypeRef = TypeInput | TypeThunk;

/** Normalized, fully resolved type expression. */
export type TypeNode =
  | { kind: 'scalar'; name: string }
  | { kind: 'object'; name: string; target: Ctor }
  | { kind: 'input'; name: string; target: Ctor }
  | { kind: 'enum'; name: string; target: EnumObject }
  | { kind: 'list'; of: TypeNode }
  | { kind: 'nonNull'; of: TypeNode };

/** The per-request value threaded through every resolver. */
export interface GraphQLContext {
  [key: string]: any;
}

/* -------------------------------------------------------------------------- */
/* Decorator options                                                          */
/* -------------------------------------------------------------------------- */

export interface SemanticTypeOptions {
  /** Schema name. Defaults to the class name. */
  name?: string;
  description?: string;
  /**
   * Marks the type as a *boundary type*: other bounded contexts are allowed to
   * reference it and to extend it with `@Extends`. Requires `key`.
   */
  boundary?: boolean;
  /** Property holding the type's identity. Required for boundary types. */
  key?: string;
  /** Type of the key field. Defaults to `ID`. */
  keyType?: TypeRef;
  /** Marks the type as a root portal — its `@Field`s become `Query` fields. */
  portal?: boolean;
  /**
   * Expose constructor parameter properties (which cannot carry decorators)
   * as fields: `{ name: () => String, email: () => String }`.
   */
  expose?: Record<string, TypeRef | FieldOptions>;
}

export interface PortalOptions extends Omit<SemanticTypeOptions, 'portal'> {}

export interface InputTypeOptions {
  name?: string;
  description?: string;
}

export interface EnumOptions {
  name: string;
  description?: string;
}

export interface FieldOptions {
  name?: string;
  description?: string;
  /** Explicit type. May also be passed positionally: `@Field(() => [Order])`. */
  type?: TypeRef;
  /** Field may return null. Fields are non-null by default. */
  nullable?: boolean;
  /** List *items* may be null. Items are non-null by default. */
  nullableItems?: boolean;
  /** Argument types, keyed by parameter name. */
  args?: Record<string, TypeRef | ArgOptions>;
  deprecated?: string;
  /**
   * Coalesce this field across the parents resolved in the same tick.
   *
   * - `true` — de-duplicates and memoizes calls per (parent, args) for the
   *   request. Removes repeated work, not the N+1 itself.
   * - `string` — name of a static method on the owning class with the signature
   *   `(parents: T[], args: any[], ctx) => R[] | Promise<R[]>`; results are
   *   matched back to parents by index. This is true batching.
   * - function — the same batch signature, inline.
   */
  batch?: boolean | string | BatchResolver;
}

export interface ActionOptions extends FieldOptions {
  /**
   * Root mutation field name. Defaults to the method name for portals, and to
   * `<typeName><Method>` (e.g. `orderCancel`) for actions declared on a type.
   */
  name?: string;
  /** Argument name carrying the entity key for actions declared on a type. */
  keyArg?: string;
}

export interface SubscriptionOptions extends FieldOptions {
  /** Drop events that do not pass the filter. */
  filter?: (payload: any, args: Record<string, any>, ctx: GraphQLContext) => boolean;
  /** Map the raw container event payload to the field's type. */
  map?: (payload: any, args: Record<string, any>, ctx: GraphQLContext) => any;
}

export interface ArgOptions {
  name?: string;
  description?: string;
  type?: TypeRef;
  nullable?: boolean;
  nullableItems?: boolean;
  defaultValue?: unknown;
}

export interface ExtendsOptions {
  /** Bounded context contributing the extension. Defaults to `@BoundedContext`. */
  context?: string;
}

/** Batch function used by `@Field({ batch })`. */
export type BatchResolver = (
  parents: any[],
  args: Array<Record<string, any>>,
  ctx: GraphQLContext,
) => any[] | Promise<any[]>;

/* -------------------------------------------------------------------------- */
/* Declarations (what decorators record)                                      */
/* -------------------------------------------------------------------------- */

export type FieldKind = 'field' | 'action' | 'subscription';

export interface ParamDeclaration {
  index: number;
  kind: 'arg' | 'context' | 'parent' | 'info';
  name?: string;
  type?: TypeRef;
  options?: ArgOptions;
}

export interface FieldDeclaration {
  propertyKey: string;
  kind: FieldKind;
  /** `method` fields are invoked; `property` fields are read off the instance. */
  member: 'method' | 'property';
  options: FieldOptions & ActionOptions & SubscriptionOptions;
  /** Container event backing a `@Subscription`. */
  event?: string;
  params: ParamDeclaration[];
}

export interface SemanticTypeDeclaration {
  target: Ctor;
  name: string;
  options: SemanticTypeOptions;
  context?: string;
  portal: boolean;
}

export interface InputTypeDeclaration {
  target: Ctor;
  name: string;
  options: InputTypeOptions;
}

export interface EnumDeclaration {
  target: EnumObject;
  name: string;
  description?: string;
}

export interface ExtensionDeclaration {
  target: Ctor;
  /** Thunk to the boundary type being extended. */
  extended: TypeThunk;
  context?: string;
}

/* -------------------------------------------------------------------------- */
/* Resolved graph                                                             */
/* -------------------------------------------------------------------------- */

/** Everything the resolver layer needs to invoke a field. */
export interface FieldSource {
  /** Class the member lives on (the portal, the type, or the extension class). */
  target: Ctor;
  propertyKey: string;
  member: 'method' | 'property';
  /** How to obtain the object the member is invoked on. */
  holder: 'portal' | 'parent' | 'extension' | 'entity';
  params: ParamDeclaration[];
  batch?: boolean | string | BatchResolver;
  /** For actions declared on a semantic type: how to load the entity. */
  entity?: {
    typeName: string;
    keyArg: string;
    lookup: { target: Ctor; propertyKey: string };
    /** Return the entity itself when the method returns nothing. */
    returnsSelf: boolean;
  };
  subscription?: {
    event: string;
    filter?: SubscriptionOptions['filter'];
    map?: SubscriptionOptions['map'];
  };
  /** Synthesized field that always resolves to this value. */
  constant?: unknown;
}

export interface ResolvedArg {
  name: string;
  description?: string;
  type: TypeNode;
  defaultValue?: unknown;
}

export interface ResolvedField {
  name: string;
  description?: string;
  type: TypeNode;
  args: ResolvedArg[];
  deprecationReason?: string;
  /** Bounded context that declared this field (may differ from the owning type). */
  context?: string;
  source: FieldSource;
}

export interface ResolvedObjectType {
  name: string;
  description?: string;
  target: Ctor;
  context?: string;
  boundary: boolean;
  key?: string;
  portal: boolean;
  fields: ResolvedField[];
}

export interface ResolvedInputField {
  name: string;
  description?: string;
  type: TypeNode;
  defaultValue?: unknown;
  propertyKey: string;
}

export interface ResolvedInputType {
  name: string;
  description?: string;
  target: Ctor;
  fields: ResolvedInputField[];
}

export interface ResolvedEnumType {
  name: string;
  description?: string;
  values: Array<{ name: string; value: string | number }>;
}

export interface ResolvedRootType {
  name: 'Query' | 'Mutation' | 'Subscription';
  fields: ResolvedField[];
}

export interface TypeGraph {
  query: ResolvedRootType;
  mutation?: ResolvedRootType;
  subscription?: ResolvedRootType;
  objects: ResolvedObjectType[];
  inputs: ResolvedInputType[];
  enums: ResolvedEnumType[];
  /** Custom scalars actually referenced by the schema. */
  scalars: string[];
  /** Bounded contexts represented in this graph. */
  contexts: string[];
}

export interface BuildOptions {
  /** Restrict the schema to these bounded contexts. Defaults to all. */
  contexts?: string[];
  /**
   * Reject cross-context references to non-boundary types. Default `true` —
   * this is the point of the package; turn it off only while migrating.
   */
  enforceBoundaries?: boolean;
  /**
   * Reject fields and arguments with no declared type instead of assuming
   * `String`. Default `false`.
   */
  strictTypes?: boolean;
  /** Registry to read declarations from. Defaults to the global registry. */
  registry?: import('./registry.ts').SemanticRegistry;
}
