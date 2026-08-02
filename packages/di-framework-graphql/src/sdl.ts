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
  ResolvedObjectType,
  TypeGraph,
  TypeNode,
} from './types.ts';

export interface PrintOptions {
  /**
   * Emit `@key` / `@context` directives describing semantic ownership.
   * Off by default so the output is plain, portable SDL.
   */
  directives?: boolean;
  /** Emit descriptions as block strings. Default `true`. */
  descriptions?: boolean;
}

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

function printObject(object: ResolvedObjectType, options: PrintOptions): string {
  const description = printDescription(object.description, '', options);
  const directives: string[] = [];
  if (options.directives) {
    if (object.boundary && object.key)
      directives.push(`@key(fields: ${JSON.stringify(object.key)})`);
    if (object.context) directives.push(`@context(name: ${JSON.stringify(object.context)})`);
  }
  const suffix = directives.length > 0 ? ` ${directives.join(' ')}` : '';
  const fields = object.fields.map((field) => printField(field, options)).join('\n');
  return `${description}type ${object.name}${suffix} {\n${fields}\n}`;
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

  for (const object of graph.objects) {
    blocks.push(printObject(object, options));
  }

  for (const root of [graph.query, graph.mutation, graph.subscription]) {
    if (!root) continue;
    const fields = root.fields.map((field) => printField(field, options)).join('\n');
    blocks.push(`type ${root.name} {\n${fields}\n}`);
  }

  return `${blocks.join('\n\n')}\n`;
}
