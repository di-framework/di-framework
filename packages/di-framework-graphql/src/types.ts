/**
 * Type model for the semantic schema.
 *
 * Decorators record *declarations* (what the author wrote). `buildTypeGraph()`
 * turns those declarations into a resolved, validated {@link TypeGraph} which is
 * the single source for both SDL printing and executable schema construction.
 */

import type { ScalarRef } from './scalars.ts';

export type Ctor<T = any> = new (...args: any[]) => T;

/**
 * A class that may be `abstract` — interfaces are declared as abstract classes,
 * and those cannot be assigned to {@link Ctor}.
 */
export type AbstractCtor<T = any> = abstract new (...args: any[]) => T;

/** An enum declared with `registerEnum()`. */
export type EnumObject = Record<string, string | number>;

/**
 * A named union over concrete `@SemanticType`s.
 *
 * Unions have no class of their own — `registerUnion()` returns one of these and
 * it is used directly as a type reference: `@Field(() => SearchResult)`.
 */
export class UnionRef {
  constructor(
    readonly unionName: string,
    readonly members: () => readonly Ctor[],
    readonly options: UnionOptions = {},
  ) {}
}

/**
 * Anything usable as a type reference in a decorator:
 * a scalar marker (`ID`, `Int`), a decorated class, a registered enum object,
 * a union marker, or a single-element array denoting a list (`[Order]`).
 */
export type TypeInput = ScalarRef | UnionRef | AbstractCtor | EnumObject | readonly TypeInput[];

/** Lazy type reference — required for types that are declared later in the file. */
export type TypeThunk = () => TypeInput;

export type TypeRef = TypeInput | TypeThunk;

/** Normalized, fully resolved type expression. */
export type TypeNode =
  | { kind: 'scalar'; name: string }
  | { kind: 'object'; name: string; target: Ctor }
  | { kind: 'interface'; name: string; target: Ctor }
  | { kind: 'union'; name: string; target: UnionRef }
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
   * Interfaces this type implements. Usually declared with `@Implements`;
   * listing them here is equivalent.
   */
  implements?: TypeThunk | readonly TypeThunk[];
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

export interface InterfaceTypeOptions {
  /** Schema name. Defaults to the class name. */
  name?: string;
  description?: string;
  /**
   * Decide the concrete type for a value. Defaults to matching the value
   * against each implementing class with `instanceof`, then falling back to a
   * `__typename` property.
   */
  resolveType?: TypeResolver;
}

export interface UnionOptions {
  description?: string;
  /** Same fallback chain as {@link InterfaceTypeOptions.resolveType}. */
  resolveType?: TypeResolver;
}

/** Returns the schema name of the concrete type backing a value. */
export type TypeResolver = (
  value: any,
  ctx: GraphQLContext,
  info: any,
) => string | undefined | Promise<string | undefined>;

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
  /** Ordered field middleware; each layer may inspect or replace the result. */
  middleware?: FieldMiddleware | readonly FieldMiddleware[];
}

export interface FieldMiddlewareContext {
  parent: unknown;
  args: Record<string, any>;
  ctx: GraphQLContext;
  info: any;
  field: ResolvedField;
}

export type FieldMiddleware = (
  next: () => unknown | Promise<unknown>,
  context: FieldMiddlewareContext,
) => unknown | Promise<unknown>;

export interface ConnectionOptions extends Omit<FieldOptions, 'type'> {
  /** Name of the generated connection type. Defaults to `<Node>Connection`. */
  connectionName?: string;
  /** Default `first` when the caller supplies no pagination arguments. */
  defaultPageSize?: number;
  /** Largest `first`/`last` accepted. Requests above it are an error. */
  maxPageSize?: number;
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
  /** Set by `@Connection`: the node type to paginate over, plus paging limits. */
  connection?: { node: TypeRef; options: ConnectionOptions };
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

export interface InterfaceTypeDeclaration {
  target: Ctor;
  name: string;
  options: InterfaceTypeOptions;
}

export interface UnionDeclaration {
  ref: UnionRef;
  name: string;
  options: UnionOptions;
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
  middleware?: FieldMiddleware | readonly FieldMiddleware[];
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
  /** Requirements that must pass before the member is read or invoked. */
  requirements?: readonly import('./authorization.ts').AuthRequirement[];
  /** Shape the result as a Relay connection, slicing arrays if needed. */
  connection?: { defaultPageSize?: number; maxPageSize?: number };
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
  /** Names of the interfaces this type implements. */
  interfaces: string[];
}

export interface ResolvedInterfaceType {
  name: string;
  description?: string;
  target: Ctor;
  context?: string;
  fields: ResolvedField[];
  /** Schema names of the object types implementing this interface. */
  implementations: string[];
  resolveType?: TypeResolver;
}

export interface ResolvedUnionType {
  name: string;
  description?: string;
  /** Schema names of the union's members. */
  members: string[];
  resolveType?: TypeResolver;
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
  interfaces: ResolvedInterfaceType[];
  unions: ResolvedUnionType[];
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
