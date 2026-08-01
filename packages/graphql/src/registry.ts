/**
 * Registry of everything the decorators have declared.
 *
 * Mirrors the HTTP package's registry: a process-wide singleton keyed by a
 * global symbol so that multiple copies of the package still agree on one
 * schema, with an escape hatch (`new SemanticRegistry()`) for tests.
 */

import type {
  Ctor,
  EnumDeclaration,
  EnumObject,
  ExtensionDeclaration,
  InputTypeDeclaration,
  SemanticTypeDeclaration,
} from './types.ts';

export class SemanticRegistry {
  private types = new Map<Ctor, SemanticTypeDeclaration>();
  private inputs = new Map<Ctor, InputTypeDeclaration>();
  private enums = new Map<EnumObject, EnumDeclaration>();
  private extensions: ExtensionDeclaration[] = [];

  registerType(declaration: SemanticTypeDeclaration): void {
    this.types.set(declaration.target, declaration);
  }

  registerInput(declaration: InputTypeDeclaration): void {
    this.inputs.set(declaration.target, declaration);
  }

  registerEnum(declaration: EnumDeclaration): void {
    this.enums.set(declaration.target, declaration);
  }

  registerExtension(declaration: ExtensionDeclaration): void {
    this.extensions.push(declaration);
  }

  getType(target: Ctor): SemanticTypeDeclaration | undefined {
    return this.types.get(target);
  }

  getInput(target: Ctor): InputTypeDeclaration | undefined {
    return this.inputs.get(target);
  }

  getEnum(target: EnumObject): EnumDeclaration | undefined {
    return this.enums.get(target);
  }

  getTypes(): SemanticTypeDeclaration[] {
    return Array.from(this.types.values());
  }

  getInputs(): InputTypeDeclaration[] {
    return Array.from(this.inputs.values());
  }

  getEnums(): EnumDeclaration[] {
    return Array.from(this.enums.values());
  }

  getExtensions(): ExtensionDeclaration[] {
    return [...this.extensions];
  }

  /** Bounded contexts that have declared something. */
  getContexts(): string[] {
    const names = new Set<string>();
    for (const declaration of this.types.values()) {
      if (declaration.context) names.add(declaration.context);
    }
    for (const extension of this.extensions) {
      if (extension.context) names.add(extension.context);
    }
    return Array.from(names);
  }

  /** Copy every declaration into a fresh registry (prototype pattern, as the container does). */
  fork(): SemanticRegistry {
    const clone = new SemanticRegistry();
    for (const [key, value] of this.types) clone.types.set(key, value);
    for (const [key, value] of this.inputs) clone.inputs.set(key, value);
    for (const [key, value] of this.enums) clone.enums.set(key, value);
    clone.extensions = [...this.extensions];
    return clone;
  }

  clear(): void {
    this.types.clear();
    this.inputs.clear();
    this.enums.clear();
    this.extensions = [];
  }
}

const GLOBAL_KEY = Symbol.for('@di-framework/graphql-registry');

/** The process-wide registry the decorators write into. */
export function getRegistry(): SemanticRegistry {
  const existing = (globalThis as any)[GLOBAL_KEY] as SemanticRegistry | undefined;
  if (existing) return existing;
  const created = new SemanticRegistry();
  (globalThis as any)[GLOBAL_KEY] = created;
  return created;
}

/**
 * Swap the process-wide registry.
 *
 * Intended for tests and for tools that assemble several schemas from
 * separately loaded modules; call it before the decorated classes are defined.
 */
export function setRegistry(replacement: SemanticRegistry): SemanticRegistry {
  const previous = getRegistry();
  (globalThis as any)[GLOBAL_KEY] = replacement;
  return previous;
}
