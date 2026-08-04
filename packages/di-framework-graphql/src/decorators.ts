/**
 * Semantic decorators.
 *
 * Domain classes are the schema. These decorators declare *semantic exposure*
 * (`@Field`, `@Action`), *ownership* (`@BoundedContext`) and *boundaries*
 * (`@SemanticType({ boundary: true })`, `@Extends`) — not a field-by-field
 * mapping onto a separately maintained SDL document.
 */

import { Container as ContainerDecorator } from '@di-framework/core/decorators';
import type { AuthRequirement } from './authorization.ts';
import { SemanticSchemaError } from './errors.ts';
import {
  defineBoundedContext,
  defineFieldDeclaration,
  defineImplements,
  defineLookup,
  defineMemberRequirements,
  defineParamDeclaration,
  defineTypeRequirements,
} from './metadata.ts';
import { getRegistry } from './registry.ts';
import { ScalarRef } from './scalars.ts';
import {
  type AbstractCtor,
  type ActionOptions,
  type ArgOptions,
  type ConnectionOptions,
  type Ctor,
  type EnumObject,
  type EnumOptions,
  type ExtendsOptions,
  type FieldOptions,
  type InputTypeOptions,
  type InterfaceTypeOptions,
  type PortalOptions,
  type SemanticTypeOptions,
  type SubscriptionOptions,
  type TypeRef,
  type TypeThunk,
  type UnionOptions,
  UnionRef,
} from './types.ts';

/* -------------------------------------------------------------------------- */
/* Argument normalization                                                     */
/* -------------------------------------------------------------------------- */

function isTypeReference(value: unknown): boolean {
  if (value instanceof ScalarRef) return true;
  if (value instanceof UnionRef) return true;
  if (Array.isArray(value)) return true;
  if (typeof value !== 'function') return false;
  // A thunk (`() => User`) is a type reference too; so is a class passed directly.
  return true;
}

/** Split `(typeOrOptions?, options?)` into an explicit `{ type, options }` pair. */
function normalizeArgs<T extends FieldOptions>(
  typeOrOptions?: TypeRef | T,
  maybeOptions?: T,
): { type?: TypeRef; options: T } {
  if (typeOrOptions === undefined) return { options: (maybeOptions ?? {}) as T };
  if (isTypeReference(typeOrOptions)) {
    return {
      type: typeOrOptions as TypeRef,
      options: (maybeOptions ?? {}) as T,
    };
  }
  return { options: (typeOrOptions ?? {}) as T };
}

/* -------------------------------------------------------------------------- */
/* Type-level decorators                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Declares a class as a semantic type in the schema.
 *
 * @example
 * ```ts
 * @BoundedContext('Users')
 * @SemanticType({ boundary: true, key: 'id' })
 * @Container()
 * class User {
 *   @Field(() => ID) id!: string;
 * }
 * ```
 *
 * `boundary: true` means other bounded contexts may reference and extend this
 * type; it is the only sanctioned way across a context edge, and it requires a
 * `key` so the object can be re-identified from the other side.
 */
export function SemanticType(options: SemanticTypeOptions = {}) {
  return <T extends Ctor>(target: T): T => {
    if (options.boundary && !options.key) {
      throw new SemanticSchemaError(
        `${target.name}: boundary types must declare a key, e.g. @SemanticType({ boundary: true, key: 'id' })`,
      );
    }

    getRegistry().registerType({
      target,
      name: options.name ?? target.name,
      options,
      // The bounded context is read at build time: class decorators apply
      // bottom-up, so @BoundedContext may not have run yet.
      portal: options.portal ?? false,
    });

    return target;
  };
}

/**
 * Declares a root object. A portal's `@Field`s become `Query` fields, its
 * `@Action`s become `Mutation` fields and its `@Subscription`s become
 * `Subscription` fields.
 *
 * Portals are registered with the DI container, so they can inject services
 * through the usual `@Component(...)` constructor parameters.
 */
export function Portal(options: PortalOptions & { singleton?: boolean } = {}) {
  return <T extends Ctor>(target: T): T => {
    const { singleton, ...typeOptions } = options;
    SemanticType({ ...typeOptions, portal: true })(target);
    ContainerDecorator({ singleton })(target as any);
    return target;
  };
}

/**
 * Declares a class as a GraphQL interface — a shared contract that concrete
 * `@SemanticType`s implement.
 *
 * The class itself is never instantiated by the schema; it exists so the shared
 * fields have somewhere to live and so implementations can inherit them by
 * extending it.
 *
 * @example
 * ```ts
 * @InterfaceType({ description: 'Anything addressable by a global id.' })
 * abstract class Node {
 *   @Field(() => ID) id!: string;
 * }
 *
 * @Implements(() => Node)
 * @SemanticType()
 * class User extends Node {}
 * ```
 */
export function InterfaceType(options: InterfaceTypeOptions = {}) {
  return <T extends AbstractCtor>(target: T): T => {
    getRegistry().registerInterface({
      target: target as unknown as Ctor,
      name: options.name ?? (target as unknown as Ctor).name,
      options,
    });
    return target;
  };
}

/**
 * Declares that a semantic type implements one or more interfaces.
 *
 * Interface fields the class does not redeclare are inherited, so a type only
 * has to write down what it adds.
 */
export function Implements(...interfaces: TypeThunk[]) {
  return <T extends Ctor>(target: T): T => {
    defineImplements(target, interfaces);
    return target;
  };
}

/**
 * Registers a union over concrete `@SemanticType`s and returns a reference
 * usable anywhere a type is expected.
 *
 * @example
 * ```ts
 * const SearchResult = registerUnion('SearchResult', () => [User, Order]);
 *
 * @Field(() => [SearchResult])
 * search(@Arg('q', () => String) q: string) { ... }
 * ```
 */
export function registerUnion(
  name: string,
  members: () => readonly Ctor[],
  options: UnionOptions = {},
): UnionRef {
  const ref = new UnionRef(name, members, options);
  getRegistry().registerUnion({ ref, name, options });
  return ref;
}

/** Declares a GraphQL input object. Its `@Field`s become input fields. */
export function InputType(options: InputTypeOptions = {}) {
  return <T extends Ctor>(target: T): T => {
    getRegistry().registerInput({
      target,
      name: options.name ?? target.name,
      options,
    });
    return target;
  };
}

/**
 * Declares the bounded context that owns a class.
 *
 * Contexts are enforced: a context may only reference or extend types owned by
 * another context when those types are boundary types.
 */
export function BoundedContext(name: string) {
  return <T extends Ctor>(target: T): T => {
    defineBoundedContext(target, name);
    return target;
  };
}

/**
 * Contributes fields to a boundary type owned by another bounded context.
 *
 * The extension class is DI-managed; its field methods receive the boundary
 * object through `@Parent()`.
 *
 * @example
 * ```ts
 * @BoundedContext('Orders')
 * @Extends(() => User)
 * @Container()
 * class UserOrders {
 *   @Field(() => [Order])
 *   orders(@Parent() user: User) { ... }
 * }
 * ```
 */
export function Extends(extended: TypeThunk, options: ExtendsOptions = {}) {
  return <T extends Ctor>(target: T): T => {
    getRegistry().registerExtension({
      target,
      extended,
      context: options.context,
    });
    ContainerDecorator({})(target as any);
    return target;
  };
}

/**
 * Registers an enum object under a schema name.
 *
 * @example
 * ```ts
 * export const OrderState = { Pending: 'Pending', Shipped: 'Shipped' } as const;
 * registerEnum(OrderState, { name: 'OrderState' });
 * ```
 */
export function registerEnum(target: EnumObject, options: EnumOptions): EnumObject {
  getRegistry().registerEnum({
    target,
    name: options.name,
    description: options.description,
  });
  return target;
}

/* -------------------------------------------------------------------------- */
/* Member decorators                                                          */
/* -------------------------------------------------------------------------- */

function declareMember(
  kind: 'field' | 'action' | 'subscription',
  type: TypeRef | undefined,
  options: FieldOptions & ActionOptions & SubscriptionOptions,
  event?: string,
) {
  return (target: any, propertyKey: string, descriptor?: PropertyDescriptor): void => {
    if (typeof target === 'function') {
      throw new SemanticSchemaError(
        `${target.name}.${propertyKey}: @${kind === 'field' ? 'Field' : 'Action'} is not supported on static members`,
      );
    }

    const member: 'method' | 'property' =
      descriptor && typeof descriptor.value === 'function' ? 'method' : 'property';

    defineFieldDeclaration(target, {
      propertyKey,
      kind,
      member,
      options: type === undefined ? options : { ...options, type },
      event,
      params: [],
    });
  };
}

/**
 * Exposes a member as a query-side field.
 *
 * @example
 * ```ts
 * @Field(() => String)
 * displayName(): string { return this.name.split(' ')[0] ?? this.name; }
 *
 * @Field(() => [Order], { batch: 'ordersFor' })
 * orders(): Order[] { ... }
 * ```
 *
 * A bare `@Field()` is assumed to be `String`; pass a type for anything else,
 * or build with `{ strictTypes: true }` to make the assumption an error.
 */
export function Field(options: FieldOptions): PropertyDecorator & MethodDecorator;
export function Field(type?: TypeRef, options?: FieldOptions): PropertyDecorator & MethodDecorator;
export function Field(typeOrOptions?: TypeRef | FieldOptions, maybeOptions?: FieldOptions): any {
  const { type, options } = normalizeArgs(typeOrOptions, maybeOptions);
  return declareMember('field', type, options);
}

/**
 * Exposes a member as a Relay cursor connection over `node`.
 *
 * The `<Node>Connection`, `<Node>Edge` and shared `PageInfo` types are
 * generated, and `first`/`after`/`last`/`before` are added to the field. The
 * method may return a plain array — sliced against those arguments — or a
 * connection built with `connectionFromSlice()` when the repository pages
 * natively.
 *
 * @example
 * ```ts
 * @Connection(() => Review, { defaultPageSize: 20, maxPageSize: 100 })
 * reviews(): Review[] { return this.repo.forBook(this.id); }
 * ```
 */
export function Connection(
  node: TypeRef,
  options: ConnectionOptions = {},
): PropertyDecorator & MethodDecorator {
  return ((target: any, propertyKey: string, descriptor?: PropertyDescriptor): void => {
    if (typeof target === 'function') {
      throw new SemanticSchemaError(
        `${target.name}.${propertyKey}: @Connection is not supported on static members`,
      );
    }
    const member: 'method' | 'property' =
      descriptor && typeof descriptor.value === 'function' ? 'method' : 'property';

    defineFieldDeclaration(target, {
      propertyKey,
      kind: 'field',
      member,
      options: options as FieldOptions,
      params: [],
      connection: { node, options },
    });
  }) as PropertyDecorator & MethodDecorator;
}

/**
 * Exposes a method as a mutation — behaviour that lives with the object owning
 * the invariant it protects.
 *
 * On a portal the method becomes a root mutation field named after the method.
 * On a semantic type it becomes `<typeName><Method>` (e.g. `orderCancel`) with
 * an implicit key argument; the entity is loaded through the type's `@Lookup`
 * before the method is invoked, so the invariant stays inside the object.
 */
export function Action(options: ActionOptions): MethodDecorator;
export function Action(type?: TypeRef, options?: ActionOptions): MethodDecorator;
export function Action(typeOrOptions?: TypeRef | ActionOptions, maybeOptions?: ActionOptions): any {
  const { type, options } = normalizeArgs<ActionOptions>(typeOrOptions, maybeOptions);
  return declareMember('action', type, options);
}

/**
 * Exposes a container event as a GraphQL subscription.
 *
 * Pairs with the core `@Publisher('order.placed')` decorator: whatever a
 * service publishes on the container can be subscribed to over GraphQL.
 */
export function Subscription(
  event: string,
  type?: TypeRef,
  options?: SubscriptionOptions,
): MethodDecorator;
export function Subscription(event: string, options: SubscriptionOptions): MethodDecorator;
export function Subscription(
  event: string,
  typeOrOptions?: TypeRef | SubscriptionOptions,
  maybeOptions?: SubscriptionOptions,
): any {
  const { type, options } = normalizeArgs<SubscriptionOptions>(typeOrOptions, maybeOptions);
  return declareMember('subscription', type, options, event);
}

/**
 * Declares what a caller must satisfy before a field or action runs.
 *
 * Auth lives with the thing it protects, and fails the way boundary checks do:
 * the requirement is part of the domain declaration rather than a guard clause
 * repeated at the top of every resolver.
 *
 * Applies to a `@Field`, an `@Action`, a portal root, or a whole class — a
 * class-level requirement guards every field on it. Requirements accumulate and
 * are conjunctive: all of them must pass.
 *
 * @example
 * ```ts
 * @Portal()
 * class Library {
 *   @Requires({ roles: ['librarian'] })
 *   @Action(() => Loan)
 *   lend(@Arg('bookId', () => ID) bookId: string) { ... }
 *
 *   @Requires({ predicate: ({ parent, ctx }) => parent.ownerId === ctx.user.id })
 *   @Field(() => String)
 *   privateNote(): string { ... }
 * }
 * ```
 */
export function Requires(
  ...requirements: AuthRequirement[]
): ClassDecorator & PropertyDecorator & MethodDecorator {
  return ((target: any, propertyKey?: string | symbol, _descriptor?: PropertyDescriptor): any => {
    if (propertyKey === undefined) {
      defineTypeRequirements(target as Ctor, requirements);
      return target;
    }
    defineMemberRequirements(target, propertyKey as string, requirements);
  }) as ClassDecorator & PropertyDecorator & MethodDecorator;
}

/**
 * Marks a static method as the way to load an instance of this type by key.
 *
 * Required for `@Action`s declared on a semantic type, and used whenever a
 * boundary reference has to be resolved back into an object.
 *
 * @example
 * ```ts
 * @Lookup()
 * static load(id: string, ctx: GraphQLContext) {
 *   return useContainer().resolve(OrderRepository).find(id);
 * }
 * ```
 */
export function Lookup() {
  return (target: any, propertyKey: string): void => {
    if (typeof target !== 'function') {
      throw new SemanticSchemaError(
        `${target?.constructor?.name}.${propertyKey}: @Lookup must be applied to a static method`,
      );
    }
    defineLookup(target as Ctor, propertyKey);
  };
}

/* -------------------------------------------------------------------------- */
/* Parameter decorators                                                       */
/* -------------------------------------------------------------------------- */

function declareParam(
  kind: 'arg' | 'context' | 'parent' | 'info',
  name?: string,
  type?: TypeRef,
  options?: ArgOptions,
) {
  return (target: any, propertyKey: string | symbol | undefined, index: number): void => {
    if (propertyKey === undefined) {
      throw new SemanticSchemaError(
        'GraphQL parameter decorators are only supported on methods, not constructors',
      );
    }
    defineParamDeclaration(target, propertyKey as string, {
      index,
      kind,
      name,
      type,
      options,
    });
  };
}

/**
 * Declares a method parameter as a GraphQL argument.
 *
 * The name defaults to the parameter name parsed from the method source; pass
 * it explicitly when shipping minified code.
 */
export function Arg(options: ArgOptions): ParameterDecorator;
export function Arg(type: TypeRef, options?: ArgOptions): ParameterDecorator;
export function Arg(name: string, type?: TypeRef, options?: ArgOptions): ParameterDecorator;
export function Arg(
  nameOrTypeOrOptions?: string | TypeRef | ArgOptions,
  typeOrOptions?: TypeRef | ArgOptions,
  maybeOptions?: ArgOptions,
): any {
  if (typeof nameOrTypeOrOptions === 'string') {
    const { type, options } = normalizeArgs<ArgOptions>(
      typeOrOptions as TypeRef | ArgOptions,
      maybeOptions,
    );
    return declareParam('arg', nameOrTypeOrOptions, type, options);
  }

  const { type, options } = normalizeArgs<ArgOptions>(
    nameOrTypeOrOptions as TypeRef | ArgOptions,
    typeOrOptions as ArgOptions,
  );
  return declareParam('arg', options.name, type, options);
}

/** Injects the per-request GraphQL context into a parameter. */
export function Ctx(): ParameterDecorator {
  return declareParam('context');
}

/** Injects the parent object into a parameter (used by `@Extends` classes). */
export function Parent(): ParameterDecorator {
  return declareParam('parent');
}

/** Injects the GraphQL resolve info into a parameter. */
export function Info(): ParameterDecorator {
  return declareParam('info');
}
