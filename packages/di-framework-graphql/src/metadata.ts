/**
 * Metadata storage.
 *
 * Reuses the core container's reflect-metadata-free metadata store so that
 * decorators from both packages compose without extra runtime dependencies.
 */

import { defineMetadata, getOwnMetadata } from '@di-framework/core/container';
import type { Ctor, FieldDeclaration, ParamDeclaration } from './types.ts';

export const FIELDS_METADATA_KEY = 'graphql:fields';
export const PARAMS_METADATA_KEY = 'graphql:params';
export const LOOKUP_METADATA_KEY = 'graphql:lookup';
export const CONTEXT_METADATA_KEY = 'graphql:bounded-context';

type FieldMap = Record<string, FieldDeclaration>;
type ParamMap = Record<string, Record<number, ParamDeclaration>>;

/** Record a field/action/subscription declaration on a prototype. */
export function defineFieldDeclaration(prototype: object, declaration: FieldDeclaration): void {
  const fields: FieldMap = getOwnMetadata(FIELDS_METADATA_KEY, prototype) || {};
  fields[declaration.propertyKey] = declaration;
  defineMetadata(FIELDS_METADATA_KEY, fields, prototype);
}

/** Record a parameter declaration (`@Arg`, `@Ctx`, `@Parent`, `@Info`). */
export function defineParamDeclaration(
  prototype: object,
  propertyKey: string,
  declaration: ParamDeclaration,
): void {
  const params: ParamMap = getOwnMetadata(PARAMS_METADATA_KEY, prototype) || {};
  const forMethod = params[propertyKey] || {};
  forMethod[declaration.index] = declaration;
  params[propertyKey] = forMethod;
  defineMetadata(PARAMS_METADATA_KEY, params, prototype);
}

export function getParamDeclarations(prototype: object, propertyKey: string): ParamDeclaration[] {
  const params: ParamMap = getOwnMetadata(PARAMS_METADATA_KEY, prototype) || {};
  const forMethod = params[propertyKey];
  if (!forMethod) return [];
  return Object.values(forMethod).sort((a, b) => a.index - b.index);
}

/**
 * Collect every declared field on a class, walking the prototype chain so that
 * subclasses inherit the semantic exposure of their base classes.
 */
export function collectFieldDeclarations(target: Ctor): FieldDeclaration[] {
  const chain: object[] = [];
  let prototype: object | null = target.prototype;
  while (prototype && prototype !== Object.prototype) {
    chain.unshift(prototype);
    prototype = Object.getPrototypeOf(prototype);
  }

  // Base first, so a redeclaration in a subclass wins.
  const merged = new Map<string, FieldDeclaration>();
  for (const proto of chain) {
    const fields: FieldMap | undefined = getOwnMetadata(FIELDS_METADATA_KEY, proto);
    if (!fields) continue;
    for (const declaration of Object.values(fields)) {
      merged.set(declaration.propertyKey, {
        ...declaration,
        params: getParamDeclarations(proto, declaration.propertyKey),
      });
    }
  }
  return Array.from(merged.values());
}

/** Record the static method used to load an entity by key (`@Lookup`). */
export function defineLookup(target: Ctor, propertyKey: string): void {
  defineMetadata(LOOKUP_METADATA_KEY, propertyKey, target);
}

export function getLookup(target: Ctor): string | undefined {
  let current: any = target;
  while (current && current !== Function.prototype) {
    const found = getOwnMetadata(LOOKUP_METADATA_KEY, current);
    if (found) return found as string;
    current = Object.getPrototypeOf(current);
  }
  return undefined;
}

/** Record the bounded context a class belongs to (`@BoundedContext`). */
export function defineBoundedContext(target: Ctor, name: string): void {
  defineMetadata(CONTEXT_METADATA_KEY, name, target);
}

export function getBoundedContext(target: Ctor): string | undefined {
  let current: any = target;
  while (current && current !== Function.prototype) {
    const found = getOwnMetadata(CONTEXT_METADATA_KEY, current);
    if (found) return found as string;
    current = Object.getPrototypeOf(current);
  }
  return undefined;
}

/**
 * Parse parameter names out of a function's source.
 *
 * The core container does the same for constructor injection. It is accurate
 * for normal builds but not for minified ones — declare argument names
 * explicitly with `@Arg('id', () => ID)` when you ship minified code.
 */
export function getParamNames(fn: Function): string[] {
  const source = fn.toString();
  const open = source.indexOf('(');
  if (open === -1) return [];

  let depth = 0;
  let close = -1;
  for (let i = open; i < source.length; i++) {
    const char = source[i];
    if (char === '(' || char === '[' || char === '{') depth++;
    else if (char === ')' || char === ']' || char === '}') {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close === -1) return [];

  const raw = source.slice(open + 1, close);
  const names: string[] = [];
  let current = '';
  depth = 0;
  for (const char of raw) {
    if (char === '(' || char === '[' || char === '{') depth++;
    else if (char === ')' || char === ']' || char === '}') depth--;

    if (char === ',' && depth === 0) {
      names.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  names.push(current);

  return names
    .map((param) => {
      const withoutDefault = param.split('=')[0] ?? '';
      const withoutType = withoutDefault.split(':')[0] ?? '';
      return withoutType.replace(/^\.\.\./, '').trim();
    })
    .filter((name) => name.length > 0);
}
