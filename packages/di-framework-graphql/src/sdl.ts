/**
 * SDL printer.
 *
 * Prints a {@link TypeGraph} without touching `graphql`, so schemas can be
 * emitted as a build artifact (the way the HTTP package emits an OpenAPI
 * document) and diffed in review.
 */

import { CUSTOM_SCALARS } from './scalars.ts';
import type {
  ResolvedArg,
  ResolvedField,
  ResolvedInterfaceType,
  ResolvedObjectType,
  TypeGraph,
  TypeNode,
} from './types.ts';

export interface PrintOptions {
  /**
   * Emit `@key` / `@context` directives describing semantic ownership.
   *
   * This is the *review* mode: it documents who owns what, in directives this
   * package defines. It is not Apollo Federation — see {@link federation}.
   * Off by default so the output is plain, portable SDL.
   */
  directives?: boolean;
  /**
   * Emit an Apollo Federation v2 subgraph document.
   *
   * Boundary types become entities: each gets a real `@key`, a type this
   * subgraph does not own is printed as a stub with `@external` key fields, and
   * the `_Any` / `_FieldSet` scalars, `_Service` type and `_Entity` union are
   * declared. Mutually exclusive with {@link directives}, which describes the
   * same ownership in this package's own vocabulary.
   */
  federation?: boolean;
  /** Federation spec URL used by the `@link` directive. */
  federationVersion?: string;
  /** Emit descriptions as block strings. Default `true`. */
  descriptions?: boolean;
}

const DEFAULT_FEDERATION_SPEC = 'https://specs.apollo.dev/federation/v2.3';

/** The two entry points a federation gateway calls on every subgraph. */
const FEDERATION_QUERY_FIELDS = (hasEntities: boolean): string =>
  [
    hasEntities ? '  _entities(representations: [_Any!]!): [_Entity]!' : undefined,
    '  _service: _Service!',
  ]
    .filter(Boolean)
    .join('\n');

export function printTypeNode(node: TypeNode): string {
  switch (node.kind) {
    case 'nonNull':
      return `${printTypeNode(node.of)}!`;
    case 'list':
      return `[${printTypeNode(node.of)}]`;
    default:
      return node.name;
  }
}

function printDescription(
  description: string | undefined,
  indent: string,
  options: PrintOptions,
): string {
  if (!description || options.descriptions === false) return '';
  const escaped = description.replace(/"""/g, '\\"""');
  if (!escaped.includes('\n')) return `${indent}"""${escaped}"""\n`;
  const body = escaped
    .split('\n')
    .map((line) => `${indent}${line}`)
    .join('\n');
  return `${indent}"""\n${body}\n${indent}"""\n`;
}

function printLiteral(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map(printLiteral).join(', ')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).map(
      ([key, item]) => `${key}: ${printLiteral(item)}`,
    );
    return `{${entries.join(', ')}}`;
  }
  return String(value);
}

function printArgs(args: ResolvedArg[], options: PrintOptions): string {
  if (args.length === 0) return '';
  const printed = args.map((arg) => {
    const defaultValue =
      arg.defaultValue === undefined ? '' : ` = ${printLiteral(arg.defaultValue)}`;
    return `${arg.name}: ${printTypeNode(arg.type)}${defaultValue}`;
  });

  const hasDescriptions =
    options.descriptions !== false && args.some((arg) => Boolean(arg.description));
  if (!hasDescriptions) return `(${printed.join(', ')})`;

  const lines = args.map((arg, index) => {
    const description = printDescription(arg.description, '    ', options);
    return `${description}    ${printed[index]}`;
  });
  return `(\n${lines.join('\n')}\n  )`;
}

function printField(field: ResolvedField, options: PrintOptions): string {
  const description = printDescription(field.description, '  ', options);
  const deprecated = field.deprecationReason
    ? ` @deprecated(reason: ${JSON.stringify(field.deprecationReason)})`
    : '';
  const context =
    options.directives && field.context ? ` @context(name: ${JSON.stringify(field.context)})` : '';
  return `${description}  ${field.name}${printArgs(field.args, options)}: ${printTypeNode(field.type)}${deprecated}${context}`;
}

/** True when the type is an entity: a boundary type re-identifiable by key. */
export function isEntity(object: ResolvedObjectType): boolean {
  return object.boundary && Boolean(object.key);
}

function printObject(object: ResolvedObjectType, options: PrintOptions): string {
  const description = printDescription(object.description, '', options);
  const directives: string[] = [];
  if (options.directives) {
    if (isEntity(object)) directives.push(`@key(fields: ${JSON.stringify(object.key)})`);
    if (object.context) directives.push(`@context(name: ${JSON.stringify(object.context)})`);
  }
  if (options.federation && isEntity(object)) {
    directives.push(`@key(fields: ${JSON.stringify(object.key)})`);
  }

  const implemented =
    object.interfaces.length > 0 ? ` implements ${object.interfaces.join(' & ')}` : '';
  const suffix = directives.length > 0 ? ` ${directives.join(' ')}` : '';

  // A stub is a type another subgraph owns: only the key is printed, marked
  // external, plus whatever this subgraph contributes.
  const fields = object.fields
    .map((field) => {
      const external =
        options.federation && object.stub && field.name === object.key ? ' @external' : '';
      return `${printField(field, options)}${external}`;
    })
    .join('\n');

  return `${description}type ${object.name}${implemented}${suffix} {\n${fields}\n}`;
}

function printInterface(resolved: ResolvedInterfaceType, options: PrintOptions): string {
  const description = printDescription(resolved.description, '', options);
  const context =
    options.directives && resolved.context
      ? ` @context(name: ${JSON.stringify(resolved.context)})`
      : '';
  const fields = resolved.fields.map((field) => printField(field, options)).join('\n');
  return `${description}interface ${resolved.name}${context} {\n${fields}\n}`;
}

/** Print the semantic schema as SDL. */
export function printSDL(graph: TypeGraph, options: PrintOptions = {}): string {
  const blocks: string[] = [];

  if (options.directives) {
    blocks.push(
      'directive @key(fields: String!) on OBJECT',
      'directive @context(name: String!) on OBJECT | FIELD_DEFINITION',
    );
  }

  const entities = graph.objects.filter(isEntity);

  if (options.federation) {
    const spec = options.federationVersion ?? DEFAULT_FEDERATION_SPEC;
    blocks.push(
      `extend schema @link(url: ${JSON.stringify(spec)}, import: ["@key", "@external", "@shareable", "@requires", "@provides"])`,
      'scalar _Any',
      'scalar _FieldSet',
      'type _Service {\n  sdl: String\n}',
    );
    if (entities.length > 0) {
      blocks.push(`union _Entity = ${entities.map((entity) => entity.name).join(' | ')}`);
    }
  }

  for (const scalar of graph.scalars) {
    if (CUSTOM_SCALARS.has(scalar)) blocks.push(`scalar ${scalar}`);
  }

  for (const enumType of graph.enums) {
    const description = printDescription(enumType.description, '', options);
    const values = enumType.values.map((value) => `  ${value.name}`).join('\n');
    blocks.push(`${description}enum ${enumType.name} {\n${values}\n}`);
  }

  for (const input of graph.inputs) {
    const description = printDescription(input.description, '', options);
    const fields = input.fields
      .map(
        (field) =>
          `${printDescription(field.description, '  ', options)}  ${field.name}: ${printTypeNode(field.type)}`,
      )
      .join('\n');
    blocks.push(`${description}input ${input.name} {\n${fields}\n}`);
  }

  for (const resolved of graph.interfaces) {
    blocks.push(printInterface(resolved, options));
  }

  for (const union of graph.unions) {
    const description = printDescription(union.description, '', options);
    blocks.push(`${description}union ${union.name} = ${union.members.join(' | ')}`);
  }

  for (const object of graph.objects) {
    blocks.push(printObject(object, options));
  }

  for (const root of [graph.query, graph.mutation, graph.subscription]) {
    if (!root) continue;
    const fields = root.fields.map((field) => printField(field, options)).join('\n');
    const federated =
      options.federation && root.name === 'Query'
        ? `\n${FEDERATION_QUERY_FIELDS(entities.length > 0)}`
        : '';
    blocks.push(`type ${root.name} {\n${fields}${federated}\n}`);
  }

  return `${blocks.join('\n\n')}\n`;
}
