/**
 * Turns decorator declarations into a resolved, validated {@link TypeGraph}.
 *
 * This module is the whole semantic layer: it decides what a bounded context is
 * allowed to say about another context's objects, where behaviour lands in the
 * schema, and how untyped declarations are filled in. It has no dependency on
 * `graphql` — both the SDL printer and the executable schema are derived from
 * its output.
 */

import { SemanticBoundaryError, SemanticSchemaError } from './errors.ts';
import {
  collectFieldDeclarations,
  getBoundedContext,
  getImplements,
  getLookup,
  getParamNames,
} from './metadata.ts';
import { getRegistry } from './registry.ts';
import { CUSTOM_SCALARS, ScalarRef, scalarNameForConstructor } from './scalars.ts';
import {
  type ArgOptions,
  type BuildOptions,
  type Ctor,
  type EnumObject,
  type FieldDeclaration,
  type ParamDeclaration,
  type ResolvedArg,
  type ResolvedEnumType,
  type ResolvedField,
  type ResolvedInputType,
  type ResolvedInterfaceType,
  type ResolvedObjectType,
  type ResolvedRootType,
  type ResolvedUnionType,
  type TypeGraph,
  type TypeInput,
  type TypeNode,
  type TypeRef,
  type TypeThunk,
  UnionRef,
} from './types.ts';

const CONTEXT_PARAM_NAMES = new Set(['ctx', 'context', '_ctx', '_context']);

function nonNull(node: TypeNode): TypeNode {
  return node.kind === 'nonNull' ? node : { kind: 'nonNull', of: node };
}

function camelCase(value: string): string {
  return value.charAt(0).toLowerCase() + value.slice(1);
}

function pascalCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** Walk a type expression down to its named type. */
export function namedTypeNode(node: TypeNode): TypeNode {
  return node.kind === 'list' || node.kind === 'nonNull' ? namedTypeNode(node.of) : node;
}

class GraphBuilder {
  private readonly registry = getRegistry();
  private readonly enforceBoundaries: boolean;
  private readonly strictTypes: boolean;
  private readonly contextFilter?: Set<string>;

  /** Semantic types included in this build, by class. */
  private readonly objects = new Map<Ctor, ResolvedObjectType>();
  private readonly objectsByName = new Map<string, ResolvedObjectType>();
  private readonly inputs = new Map<Ctor, ResolvedInputType>();
  private readonly enums = new Map<EnumObject, ResolvedEnumType>();
  /** Interfaces included in this build, by class. */
  private readonly interfaces = new Map<Ctor, ResolvedInterfaceType>();
  private readonly unions = new Map<UnionRef, ResolvedUnionType>();
  private readonly usedScalars = new Set<string>();
  /** Context that declared each field, keyed by `TypeName.fieldName`. */
  private readonly fieldContexts = new Map<string, string | undefined>();

  constructor(options: BuildOptions) {
    this.registry = options.registry ?? getRegistry();
    this.enforceBoundaries = options.enforceBoundaries ?? true;
    this.strictTypes = options.strictTypes ?? false;
    this.contextFilter = options.contexts ? new Set(options.contexts) : undefined;
  }

  build(): TypeGraph {
    const declarations = this.registry
      .getTypes()
      .filter((declaration) => this.inSelectedContext(getBoundedContext(declaration.target)));

    // Pass 1: shells, so fields can reference types declared later.
    for (const declaration of declarations) {
      if (declaration.portal) continue;
      const shell: ResolvedObjectType = {
        name: declaration.name,
        description: declaration.options.description,
        target: declaration.target,
        context: getBoundedContext(declaration.target),
        boundary: declaration.options.boundary ?? false,
        key: declaration.options.key,
        portal: false,
        fields: [],
        interfaces: [],
      };
      const existing = this.objectsByName.get(shell.name);
      if (existing && existing.target !== shell.target) {
        throw new SemanticSchemaError(
          `Two classes claim the semantic type '${shell.name}': ${existing.target.name} and ${shell.target.name}. Give one of them an explicit name.`,
        );
      }
      this.objects.set(declaration.target, shell);
      this.objectsByName.set(shell.name, shell);
    }

    // Pass 2: interface shells, so a type can implement an interface that
    // references it back.
    for (const declaration of this.registry.getInterfaces()) {
      this.interfaces.set(declaration.target, {
        name: declaration.name,
        description: declaration.options.description,
        target: declaration.target,
        context: getBoundedContext(declaration.target),
        fields: [],
        implementations: [],
        resolveType: declaration.options.resolveType,
      });
    }

    // Pass 3: own fields.
    for (const object of this.objects.values()) {
      object.fields = this.resolveOwnFields(object);
    }
    for (const [target, resolved] of this.interfaces) {
      resolved.fields = this.resolveInterfaceFields(target, resolved);
    }

    // Pass 4: wire implementations to their interfaces and inherit any fields
    // the concrete type did not redeclare.
    this.applyInterfaces();

    // Pass 5: cross-context extensions of boundary types.
    this.applyExtensions();

    // Pass 6: roots.
    const rootQuery: ResolvedField[] = [];
    const rootMutation: ResolvedField[] = [];
    const rootSubscription: ResolvedField[] = [];

    for (const declaration of declarations) {
      if (!declaration.portal) continue;
      const context = getBoundedContext(declaration.target);
      for (const field of collectFieldDeclarations(declaration.target)) {
        const resolved = this.resolvePortalField(
          declaration.target,
          declaration.name,
          field,
          context,
        );
        if (field.kind === 'field') rootQuery.push(resolved);
        else if (field.kind === 'action') rootMutation.push(resolved);
        else rootSubscription.push(resolved);
      }
    }

    // Behaviour declared on the objects that own the invariants also surfaces
    // as a root mutation, keyed by the boundary key.
    for (const object of this.objects.values()) {
      rootMutation.push(...this.resolveEntityActions(object));
    }

    assertUniqueFieldNames('Query', rootQuery);
    assertUniqueFieldNames('Mutation', rootMutation);
    assertUniqueFieldNames('Subscription', rootSubscription);

    if (rootQuery.length === 0) {
      rootQuery.push(this.contextsField());
    }

    const graph: TypeGraph = {
      query: { name: 'Query', fields: rootQuery },
      mutation: rootMutation.length > 0 ? { name: 'Mutation', fields: rootMutation } : undefined,
      subscription:
        rootSubscription.length > 0
          ? { name: 'Subscription', fields: rootSubscription }
          : undefined,
      objects: Array.from(this.objects.values()).sort((a, b) => a.name.localeCompare(b.name)),
      interfaces: [],
      unions: [],
      inputs: [],
      enums: [],
      scalars: [],
      contexts: this.collectContexts(),
    };

    this.validateBoundaries(graph);

    // Inputs and enums are plumbing: only emit the ones actually reachable.
    const reachable = this.collectReachable(graph);
    graph.inputs = reachable.inputs;
    graph.enums = reachable.enums;
    graph.scalars = Array.from(this.usedScalars).sort();

    // An interface is emitted when something implements it or a field returns
    // it; an orphan interface would make the schema invalid.
    graph.interfaces = Array.from(this.interfaces.values())
      .filter(
        (resolved) => resolved.implementations.length > 0 || reachable.abstracts.has(resolved.name),
      )
      .sort((a, b) => a.name.localeCompare(b.name));
    graph.unions = Array.from(this.unions.values()).sort((a, b) => a.name.localeCompare(b.name));

    return graph;
  }

  /* ---------------------------------------------------------------------- */
  /* Fields                                                                  */
  /* ---------------------------------------------------------------------- */

  private resolveOwnFields(object: ResolvedObjectType): ResolvedField[] {
    const fields: ResolvedField[] = [];
    const declarations = collectFieldDeclarations(object.target);

    for (const declaration of declarations) {
      if (declaration.kind === 'action') continue; // handled as root mutations
      if (declaration.kind === 'subscription') {
        throw new SemanticSchemaError(
          `${object.name}.${declaration.propertyKey}: @Subscription is only supported on portals`,
        );
      }
      fields.push(
        this.resolveField(object.target, object.name, declaration, 'parent', object.context),
      );
    }

    for (const [propertyKey, spec] of Object.entries(this.exposedMembers(object))) {
      if (fields.some((field) => field.source.propertyKey === propertyKey)) continue;
      fields.push(
        this.resolveField(
          object.target,
          object.name,
          {
            propertyKey,
            kind: 'field',
            member: 'property',
            options: spec,
            params: [],
          },
          'parent',
          object.context,
        ),
      );
    }

    // A boundary type is identified by its key, so the key is always exposed.
    if (object.key && !fields.some((field) => field.source.propertyKey === object.key)) {
      const declaration = this.registry.getType(object.target);
      fields.unshift(
        this.resolveField(
          object.target,
          object.name,
          {
            propertyKey: object.key,
            kind: 'field',
            member: 'property',
            options: { type: declaration?.options.keyType ?? new ScalarRef('ID') },
            params: [],
          },
          'parent',
          object.context,
        ),
      );
    }

    assertUniqueFieldNames(object.name, fields);
    return fields;
  }

  private resolveInterfaceFields(target: Ctor, resolved: ResolvedInterfaceType): ResolvedField[] {
    const fields = collectFieldDeclarations(target).map((declaration) => {
      if (declaration.kind !== 'field') {
        throw new SemanticSchemaError(
          `${resolved.name}.${declaration.propertyKey}: interfaces may only declare @Field members.`,
        );
      }
      return this.resolveField(target, resolved.name, declaration, 'parent', resolved.context);
    });

    if (fields.length === 0) {
      throw new SemanticSchemaError(
        `${resolved.name}: interfaces need at least one @Field. GraphQL has no empty interfaces.`,
      );
    }

    assertUniqueFieldNames(resolved.name, fields);
    return fields;
  }

  /**
   * Attach each object to the interfaces it declares, copying down any field it
   * did not redeclare so the concrete type structurally satisfies the contract.
   */
  private applyInterfaces(): void {
    for (const object of this.objects.values()) {
      const thunks = [
        ...getImplements(object.target),
        ...normalizeThunks(this.registry.getType(object.target)?.options.implements),
      ];
      if (thunks.length === 0) continue;

      const names = new Set<string>();
      for (const thunk of thunks) {
        const interfaceTarget = thunk() as Ctor;
        const resolved = this.interfaces.get(interfaceTarget);
        if (!resolved) {
          throw new SemanticSchemaError(
            `${object.name} implements '${interfaceTarget?.name}', which is not an @InterfaceType.`,
          );
        }
        if (names.has(resolved.name)) continue;
        names.add(resolved.name);

        for (const field of resolved.fields) {
          const own = object.fields.find((existing) => existing.name === field.name);
          if (!own) {
            // Re-target the inherited field at the concrete class so an override
            // on the implementation wins over the interface's own member.
            object.fields.push({
              ...field,
              context: object.context,
              source: { ...field.source, target: object.target },
            });
            continue;
          }
          if (printableType(own.type) !== printableType(field.type)) {
            throw new SemanticBoundaryError(
              `${object.name}.${own.name} is '${printableType(own.type)}' but interface '${resolved.name}' declares '${printableType(field.type)}'.`,
            );
          }
        }

        resolved.implementations.push(object.name);
      }

      object.interfaces = Array.from(names).sort();
      assertUniqueFieldNames(object.name, object.fields);
    }

    for (const resolved of this.interfaces.values()) {
      resolved.implementations = Array.from(new Set(resolved.implementations)).sort();
    }
  }

  private ensureUnion(ref: UnionRef, path: string): ResolvedUnionType {
    const existing = this.unions.get(ref);
    if (existing) return existing;

    const declaration = this.registry.getUnion(ref);
    if (!declaration) {
      throw new SemanticSchemaError(
        `${path}: union '${ref.unionName}' was never registered with registerUnion().`,
      );
    }

    const resolved: ResolvedUnionType = {
      name: declaration.name,
      description: declaration.options.description,
      members: [],
      resolveType: declaration.options.resolveType,
    };
    this.unions.set(ref, resolved);

    const members = ref.members();
    if (members.length === 0) {
      throw new SemanticSchemaError(`${path}: union '${ref.unionName}' has no members.`);
    }
    for (const member of members) {
      const object = this.objects.get(member);
      if (!object) {
        throw new SemanticSchemaError(
          `${path}: union '${ref.unionName}' includes '${member?.name}', which is not a @SemanticType in this schema.`,
        );
      }
      resolved.members.push(object.name);
    }
    resolved.members.sort();
    return resolved;
  }

  private exposedMembers(object: ResolvedObjectType): Record<string, any> {
    const expose = this.registry.getType(object.target)?.options.expose ?? {};
    const normalized: Record<string, any> = {};
    for (const [key, value] of Object.entries(expose)) {
      normalized[key] = isFieldOptions(value) ? value : { type: value };
    }
    return normalized;
  }

  private resolveField(
    target: Ctor,
    ownerName: string,
    declaration: FieldDeclaration,
    holder: 'portal' | 'parent' | 'extension',
    context: string | undefined,
  ): ResolvedField {
    const name = declaration.options.name ?? declaration.propertyKey;
    const path = `${ownerName}.${name}`;
    const type = this.resolveTypeRef(declaration.options.type, declaration.options, path);
    const { params, args } = this.planParams(target, declaration, holder, path);

    this.fieldContexts.set(path, context);

    return {
      name,
      description: declaration.options.description,
      type,
      args,
      deprecationReason: declaration.options.deprecated,
      context,
      source: {
        target,
        propertyKey: declaration.propertyKey,
        member: declaration.member,
        holder,
        params,
        batch: declaration.options.batch,
        middleware: declaration.options.middleware,
        subscription: declaration.event
          ? {
              event: declaration.event,
              filter: declaration.options.filter,
              map: declaration.options.map,
            }
          : undefined,
      },
    };
  }

  private resolvePortalField(
    target: Ctor,
    portalName: string,
    declaration: FieldDeclaration,
    context: string | undefined,
  ): ResolvedField {
    if (declaration.kind === 'subscription' && !declaration.event) {
      throw new SemanticSchemaError(`${portalName}.${declaration.propertyKey}: missing event name`);
    }
    const rootName =
      declaration.kind === 'subscription'
        ? 'Subscription'
        : declaration.kind === 'action'
          ? 'Mutation'
          : 'Query';
    return this.resolveField(target, rootName, declaration, 'portal', context);
  }

  private resolveEntityActions(object: ResolvedObjectType): ResolvedField[] {
    const declarations = collectFieldDeclarations(object.target).filter(
      (declaration) => declaration.kind === 'action',
    );
    if (declarations.length === 0) return [];

    const lookup = getLookup(object.target);
    if (!lookup) {
      throw new SemanticSchemaError(
        `${object.name} declares @Action methods but has no @Lookup static method to load an instance by key.`,
      );
    }
    const keyArg = object.key;
    if (!keyArg) {
      throw new SemanticSchemaError(
        `${object.name} declares @Action methods but has no key. Add @SemanticType({ key: 'id' }).`,
      );
    }

    const declaredKeyType = this.registry.getType(object.target)?.options.keyType;

    return declarations.map((declaration) => {
      const name =
        declaration.options.name ??
        `${camelCase(object.name)}${pascalCase(declaration.propertyKey)}`;
      const path = `Mutation.${name}`;
      const hasExplicitType = declaration.options.type !== undefined;
      const type = hasExplicitType
        ? this.resolveTypeRef(declaration.options.type, declaration.options, path)
        : nonNull({ kind: 'object', name: object.name, target: object.target });

      const { params, args } = this.planParams(object.target, declaration, 'entity', path);
      const keyArgName = declaration.options.keyArg ?? keyArg;
      if (!args.some((arg) => arg.name === keyArgName)) {
        args.unshift({
          name: keyArgName,
          description: `Identifies the ${object.name} the action is performed on.`,
          type: this.resolveTypeRef(declaredKeyType ?? new ScalarRef('ID'), {}, path),
        });
      }

      this.fieldContexts.set(path, object.context);

      return {
        name,
        description: declaration.options.description,
        type,
        args,
        deprecationReason: declaration.options.deprecated,
        context: object.context,
        source: {
          target: object.target,
          propertyKey: declaration.propertyKey,
          member: declaration.member,
          holder: 'entity',
          params,
          entity: {
            typeName: object.name,
            keyArg: keyArgName,
            lookup: { target: object.target, propertyKey: lookup },
            returnsSelf: !hasExplicitType,
          },
        },
      };
    });
  }

  private contextsField(): ResolvedField {
    const contexts = this.collectContexts();
    return {
      name: '_contexts',
      description: 'Bounded contexts represented in this schema.',
      type: nonNull({ kind: 'list', of: nonNull({ kind: 'scalar', name: 'String' }) }),
      args: [],
      source: {
        target: Object as unknown as Ctor,
        propertyKey: '_contexts',
        member: 'property',
        holder: 'portal',
        params: [],
        constant: contexts,
      },
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Parameters and arguments                                                */
  /* ---------------------------------------------------------------------- */

  private planParams(
    target: Ctor,
    declaration: FieldDeclaration,
    holder: 'portal' | 'parent' | 'extension' | 'entity',
    path: string,
  ): { params: ParamDeclaration[]; args: ResolvedArg[] } {
    if (declaration.member !== 'method') return { params: [], args: [] };

    const method = (target.prototype as any)?.[declaration.propertyKey];
    const names = typeof method === 'function' ? getParamNames(method) : [];
    const declared = new Map(declaration.params.map((param) => [param.index, param]));
    const count = Math.max(
      names.length,
      ...Array.from(declared.keys()).map((index) => index + 1),
      0,
    );

    const params: ParamDeclaration[] = [];
    const args: ResolvedArg[] = [];

    for (let index = 0; index < count; index++) {
      const explicit = declared.get(index);
      const parsedName = names[index];

      if (explicit && explicit.kind !== 'arg') {
        params.push(explicit);
        continue;
      }

      if (!explicit && parsedName && CONTEXT_PARAM_NAMES.has(parsedName)) {
        params.push({ index, kind: 'context' });
        continue;
      }
      if (!explicit && parsedName === 'info') {
        params.push({ index, kind: 'info' });
        continue;
      }
      if (!explicit && parsedName === 'parent' && holder === 'extension') {
        params.push({ index, kind: 'parent' });
        continue;
      }

      const name = explicit?.name ?? explicit?.options?.name ?? parsedName;
      if (!name) {
        throw new SemanticSchemaError(
          `${path}: cannot determine the name of argument #${index}. Declare it with @Arg('name', () => Type).`,
        );
      }

      const override = declaration.options.args?.[name];
      const overrideOptions: ArgOptions = isArgOptions(override) ? override : {};
      const argOptions: ArgOptions = { ...overrideOptions, ...(explicit?.options ?? {}) };
      const typeRef =
        explicit?.type ??
        argOptions.type ??
        (override !== undefined && !isArgOptions(override) ? (override as TypeRef) : undefined);

      params.push({ index, kind: 'arg', name, type: typeRef, options: argOptions });
      args.push({
        name,
        description: argOptions.description,
        type: this.resolveTypeRef(typeRef, argOptions, `${path}(${name})`),
        defaultValue: argOptions.defaultValue,
      });
    }

    return { params, args };
  }

  /* ---------------------------------------------------------------------- */
  /* Type references                                                         */
  /* ---------------------------------------------------------------------- */

  private resolveTypeRef(
    ref: TypeRef | undefined,
    options: { nullable?: boolean; nullableItems?: boolean },
    path: string,
  ): TypeNode {
    if (ref === undefined) {
      if (this.strictTypes) {
        throw new SemanticSchemaError(
          `${path}: no type declared. Pass one, e.g. @Field(() => String).`,
        );
      }
      return options.nullable
        ? { kind: 'scalar', name: 'String' }
        : nonNull({ kind: 'scalar', name: 'String' });
    }

    const node = this.fromTypeInput(unwrapThunk(ref, this.registry), options, path);
    return options.nullable ? node : nonNull(node);
  }

  private fromTypeInput(
    input: TypeInput,
    options: { nullableItems?: boolean },
    path: string,
  ): TypeNode {
    if (Array.isArray(input)) {
      const [item] = input;
      if (item === undefined) {
        throw new SemanticSchemaError(`${path}: empty list type. Write [Type], not [].`);
      }
      const inner = this.fromTypeInput(unwrapThunk(item as TypeRef, this.registry), options, path);
      return { kind: 'list', of: options.nullableItems ? inner : nonNull(inner) };
    }

    if (input instanceof ScalarRef) {
      if (CUSTOM_SCALARS.has(input.scalarName)) this.usedScalars.add(input.scalarName);
      return { kind: 'scalar', name: input.scalarName };
    }

    if (input instanceof UnionRef) {
      const union = this.ensureUnion(input, path);
      return { kind: 'union', name: union.name, target: input };
    }

    if (typeof input === 'function') {
      const scalarName = scalarNameForConstructor(input);
      if (scalarName) {
        if (CUSTOM_SCALARS.has(scalarName)) this.usedScalars.add(scalarName);
        return { kind: 'scalar', name: scalarName };
      }

      const objectType = this.objects.get(input as Ctor);
      if (objectType) return { kind: 'object', name: objectType.name, target: input as Ctor };

      const interfaceType = this.interfaces.get(input as Ctor);
      if (interfaceType) {
        return { kind: 'interface', name: interfaceType.name, target: input as Ctor };
      }

      const inputDeclaration = this.registry.getInput(input as Ctor);
      if (inputDeclaration) {
        this.ensureInput(input as Ctor);
        return { kind: 'input', name: inputDeclaration.name, target: input as Ctor };
      }

      if (this.registry.getType(input as Ctor)) {
        const declaration = this.registry.getType(input as Ctor)!;
        throw new SemanticSchemaError(
          `${path}: '${declaration.name}' is ${declaration.portal ? 'a portal and cannot be used as a field type' : `outside the selected bounded contexts (${getBoundedContext(input as Ctor) ?? 'none'})`}.`,
        );
      }

      throw new SemanticSchemaError(
        `${path}: '${(input as Ctor).name}' is not a semantic type. Add @SemanticType() or @InputType().`,
      );
    }

    if (input && typeof input === 'object') {
      const enumDeclaration = this.registry.getEnum(input as EnumObject);
      if (enumDeclaration) {
        this.ensureEnum(input as EnumObject);
        return { kind: 'enum', name: enumDeclaration.name, target: input as EnumObject };
      }
    }

    throw new SemanticSchemaError(`${path}: unsupported type reference ${String(input)}.`);
  }

  private ensureInput(target: Ctor): ResolvedInputType {
    const existing = this.inputs.get(target);
    if (existing) return existing;

    const declaration = this.registry.getInput(target)!;
    const resolved: ResolvedInputType = {
      name: declaration.name,
      description: declaration.options.description,
      target,
      fields: [],
    };
    this.inputs.set(target, resolved);

    resolved.fields = collectFieldDeclarations(target).map((field) => {
      const name = field.options.name ?? field.propertyKey;
      return {
        name,
        description: field.options.description,
        type: this.resolveTypeRef(field.options.type, field.options, `${declaration.name}.${name}`),
        propertyKey: field.propertyKey,
      };
    });

    if (resolved.fields.length === 0) {
      throw new SemanticSchemaError(
        `${declaration.name}: input types need at least one @Field. GraphQL has no empty input objects.`,
      );
    }

    return resolved;
  }

  private ensureEnum(target: EnumObject): void {
    if (this.enums.has(target)) return;
    const declaration = this.registry.getEnum(target)!;
    this.enums.set(target, {
      name: declaration.name,
      description: declaration.description,
      values: Object.entries(target)
        .filter(([, value]) => typeof value === 'string' || typeof value === 'number')
        .map(([name, value]) => ({ name, value })),
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Boundaries                                                              */
  /* ---------------------------------------------------------------------- */

  private applyExtensions(): void {
    for (const extension of this.registry.getExtensions()) {
      const context = extension.context ?? getBoundedContext(extension.target);
      if (!this.inSelectedContext(context)) continue;

      const extendedTarget = extension.extended() as Ctor;
      const object = this.objects.get(extendedTarget);
      if (!object) {
        const declaration = this.registry.getType(extendedTarget);
        if (declaration && !this.inSelectedContext(getBoundedContext(extendedTarget))) continue;
        throw new SemanticSchemaError(
          `${extension.target.name} extends '${extendedTarget?.name}', which is not a @SemanticType.`,
        );
      }

      if (this.enforceBoundaries && context !== object.context && !object.boundary) {
        throw new SemanticBoundaryError(
          `${extension.target.name} (context '${context ?? 'none'}') cannot extend '${object.name}', which is owned by context '${object.context ?? 'none'}' and is not a boundary type. Declare it with @SemanticType({ boundary: true, key: '...' }) to open it up.`,
        );
      }

      for (const declaration of collectFieldDeclarations(extension.target)) {
        if (declaration.kind !== 'field') {
          throw new SemanticSchemaError(
            `${extension.target.name}.${declaration.propertyKey}: extensions may only declare @Field members.`,
          );
        }
        const field = this.resolveField(
          extension.target,
          object.name,
          declaration,
          'extension',
          context,
        );
        if (object.fields.some((existing) => existing.name === field.name)) {
          throw new SemanticBoundaryError(
            `${extension.target.name} cannot add '${field.name}' to '${object.name}': the field already exists.`,
          );
        }
        object.fields.push(field);
      }
    }
  }

  /**
   * Cross-context references must go through boundary types. This is what makes
   * the contexts real rather than decorative.
   */
  private validateBoundaries(graph: TypeGraph): void {
    if (!this.enforceBoundaries) return;

    const checkObject = (ownerName: string, fieldName: string, from: string | undefined) => {
      return (referenced: ResolvedObjectType | undefined) => {
        if (!referenced) return;
        const to = referenced.context;
        if (!from || !to || from === to) return;
        if (referenced.boundary) return;

        throw new SemanticBoundaryError(
          `${ownerName}.${fieldName} (context '${from}') references '${referenced.name}', which is owned by context '${to}' and is not a boundary type. Declare it with @SemanticType({ boundary: true, key: '...' }) or keep the reference inside '${to}'.`,
        );
      };
    };

    const check = (ownerName: string, field: ResolvedField) => {
      const named = namedTypeNode(field.type);
      const verify = checkObject(ownerName, field.name, field.context);

      if (named.kind === 'object') {
        verify(this.objects.get(named.target as Ctor));
        return;
      }
      // A union or interface is only as closed as its widest member: crossing a
      // context edge through one has to obey the same rule.
      if (named.kind === 'union') {
        const union = this.unions.get(named.target as UnionRef);
        for (const member of union?.members ?? []) verify(this.objectsByName.get(member));
        return;
      }
      if (named.kind === 'interface') {
        const resolved = this.interfaces.get(named.target as Ctor);
        for (const name of resolved?.implementations ?? []) verify(this.objectsByName.get(name));
      }
    };

    for (const object of this.objects.values()) {
      for (const field of object.fields) check(object.name, field);
    }
    for (const root of [graph.query, graph.mutation, graph.subscription]) {
      if (!root) continue;
      for (const field of root.fields) check(root.name, field);
    }
  }

  private inSelectedContext(context: string | undefined): boolean {
    if (!this.contextFilter) return true;
    // Context-free declarations are shared plumbing and always included.
    return context === undefined || this.contextFilter.has(context);
  }

  private collectContexts(): string[] {
    const names = new Set<string>();
    for (const object of this.objects.values()) if (object.context) names.add(object.context);
    for (const declaration of this.registry.getTypes()) {
      const context = getBoundedContext(declaration.target);
      if (declaration.portal && context && this.inSelectedContext(context)) names.add(context);
    }
    return Array.from(names).sort();
  }

  /** Inputs and enums reachable from the emitted fields. */
  private collectReachable(graph: TypeGraph): {
    inputs: ResolvedInputType[];
    enums: ResolvedEnumType[];
    abstracts: Set<string>;
  } {
    const inputs = new Map<string, ResolvedInputType>();
    const enums = new Map<string, ResolvedEnumType>();
    const abstracts = new Set<string>();

    const visitNode = (node: TypeNode) => {
      const named = namedTypeNode(node);
      if (named.kind === 'interface' || named.kind === 'union') {
        abstracts.add(named.name);
      }
      if (named.kind === 'input') {
        const resolved = this.inputs.get(named.target as Ctor);
        if (resolved && !inputs.has(resolved.name)) {
          inputs.set(resolved.name, resolved);
          for (const field of resolved.fields) visitNode(field.type);
        }
      } else if (named.kind === 'enum') {
        const resolved = this.enums.get(named.target as EnumObject);
        if (resolved) enums.set(resolved.name, resolved);
      } else if (named.kind === 'scalar' && CUSTOM_SCALARS.has(named.name)) {
        this.usedScalars.add(named.name);
      }
    };

    const visitField = (field: ResolvedField) => {
      visitNode(field.type);
      for (const arg of field.args) visitNode(arg.type);
    };

    for (const object of graph.objects) object.fields.forEach(visitField);
    for (const resolved of this.interfaces.values()) resolved.fields.forEach(visitField);
    for (const root of [graph.query, graph.mutation, graph.subscription]) {
      if (root) root.fields.forEach(visitField);
    }

    return {
      inputs: Array.from(inputs.values()).sort((a, b) => a.name.localeCompare(b.name)),
      enums: Array.from(enums.values()).sort((a, b) => a.name.localeCompare(b.name)),
      abstracts,
    };
  }
}

function assertUniqueFieldNames(ownerName: string, fields: ResolvedField[]): void {
  const seen = new Map<string, string>();
  for (const field of fields) {
    const previous = seen.get(field.name);
    if (previous) {
      throw new SemanticSchemaError(
        `${ownerName}.${field.name} is declared twice (${previous} and ${field.source.target.name}.${field.source.propertyKey}). Rename one with @Field({ name: '...' }).`,
      );
    }
    seen.set(field.name, `${field.source.target.name}.${field.source.propertyKey}`);
  }
}

function isFieldOptions(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof ScalarRef)
  );
}

function isArgOptions(value: unknown): value is ArgOptions {
  return isFieldOptions(value);
}

/** Render a resolved type expression the way SDL would, for error messages. */
function printableType(node: TypeNode): string {
  if (node.kind === 'nonNull') return `${printableType(node.of)}!`;
  if (node.kind === 'list') return `[${printableType(node.of)}]`;
  return node.name;
}

function normalizeThunks(value: TypeThunk | readonly TypeThunk[] | undefined): TypeThunk[] {
  if (!value) return [];
  return Array.isArray(value) ? [...value] : [value as TypeThunk];
}

/** Call a type thunk, leaving classes, scalars and lists untouched. */
function unwrapThunk(ref: TypeRef, registry: ReturnType<typeof getRegistry>): TypeInput {
  if (typeof ref !== 'function') return ref as TypeInput;
  if (ref instanceof ScalarRef) return ref;
  if (scalarNameForConstructor(ref)) return ref as TypeInput;
  if (
    registry.getType(ref as Ctor) ||
    registry.getInput(ref as Ctor) ||
    registry.getInterface(ref as Ctor)
  )
    return ref as TypeInput;
  if (/^class[\s{]/.test(Function.prototype.toString.call(ref))) return ref as TypeInput;
  return (ref as TypeThunk)();
}

/**
 * Resolve every decorated class into a validated type graph.
 *
 * Pure: no `graphql` dependency, so it can also be used to emit SDL at build
 * time or to assert architectural rules in a test.
 */
export function buildTypeGraph(options: BuildOptions = {}): TypeGraph {
  return new GraphBuilder(options).build();
}
