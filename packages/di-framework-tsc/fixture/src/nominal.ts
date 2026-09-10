import type { ExternalToken } from './external-token.js';
// biome-ignore lint/style/useImportType: verifies that an ordinary import used only as a type is safely skipped
import { ImportedToken } from './external-token.js';

export enum NumericRole {
  Guest,
  Admin = 2,
  // biome-ignore lint/suspicious/noDuplicateEnumValues: verifies guard value deduplication
  Owner = 2,
}

export enum StringState {
  Ready = 'ready',
  Done = 'done',
}

// biome-ignore lint/suspicious/noConstEnum: const-enum guarding is the behavior under test
export const enum ConstLevel {
  Low = 10,
  High = 20,
}

enum ComputedEnum {
  Fixed = 1,
  // biome-ignore lint/style/useLiteralEnumMembers: verifies safe skipping of computed enums
  Dynamic = Math.random(),
}

export class Token {
  constructor(public readonly value: string) {}
}

export class DerivedToken extends Token {}

// biome-ignore lint/style/noNamespace: verifies qualified local runtime constructors
export namespace Domain {
  export class NamespacedToken {
    constructor(public readonly value: string) {}
  }
}

interface TokenShape {
  value: string;
}

export function numericEnum(value: NumericRole): NumericRole {
  return value;
}

export function stringEnum(value: StringState): StringState {
  return value;
}

export function constEnum(value: ConstLevel): ConstLevel {
  return value;
}

export function computedEnum(value: ComputedEnum): ComputedEnum {
  return value;
}

export function useToken(token: Token): string {
  return token.value;
}

export function useTokens(tokens: Token[]): string[] {
  return tokens.map((token) => token.value);
}

export function tokenOrState(value: Token | StringState): string {
  return value instanceof Token ? value.value : value;
}

export function useTokenShape(token: TokenShape): string {
  return token.value;
}

export function typeOnlyToken(token: ExternalToken): string {
  return token.value;
}

export function importedToken(token: ImportedToken): string {
  return token.value;
}

export function namespacedToken(token: Domain.NamespacedToken): string {
  return token.value;
}
