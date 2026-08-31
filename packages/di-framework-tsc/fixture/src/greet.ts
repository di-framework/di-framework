interface User {
  id: number;
  name: string;
}

export function greet(user: User): string {
  return `hello ${user.name}`;
}

export function add(a: number, b: number): number {
  return a + b;
}

export class Greeter {
  constructor(private readonly prefix: string) {}

  greet(user: User): string {
    return `${this.prefix} ${user.name}`;
  }
}

export const multiply = (value: number, by: number): number => {
  return value * by;
};

export const divide = (value: number, by: number): number => value / by;

export function nestedFactory() {
  return (enabled: boolean) => {
    return enabled;
  };
}

export const increment = (value: number) => value + 1;
export const asyncIncrement = async (value: number) => value + 1;

export function literalValues(
  state: 'active',
  count: 0,
  enabled: true,
  absent: null,
  missing: undefined,
) {
  return { state, count, enabled, absent, missing };
}

type Success = { kind: 'success'; value: number };
type Failure = { kind: 'failure'; message: string };

export function unionValues(
  value: string | number,
  nullable: string | null,
  result: Success | Failure,
) {
  return { value, nullable, result };
}

export function arrayValues(numbers: number[], users: ReadonlyArray<User>) {
  return { numbers, users };
}

export function tupleValues(
  pair: [number, string],
  nested: [string, User],
  optional: [number, string?],
) {
  return { pair, nested, optional };
}

export function optionalValues(required: number, label?: string, count: number = 1) {
  return { required, label, count };
}

type LeftDetails = { left: string; shared: number };
type RightDetails = { right: boolean; shared: number };
type NestedIntersection = { item: { id: number } & { 'x-id': string | undefined } };
type IntersectionAlternative =
  | ({ kind: 'full' } & { count: number })
  | { kind: 'fallback'; enabled: boolean };

export function intersectionValues(
  value: LeftDetails & RightDetails,
  nested: NestedIntersection,
  alternative: IntersectionAlternative,
) {
  return { value, nested, alternative };
}

export function intersectionArray(entries: Array<{ left: number } & { right: string }>) {
  return entries;
}

type IndexedNumbers = { fixed: number } & { [key: string]: number };
type FixedNumberRecord = Record<'primary' | 'x-id', number>;

export function recordValues(
  indexed: IndexedNumbers,
  record: Record<string, number>,
  fixed: FixedNumberRecord,
) {
  return { indexed, record, fixed };
}

export function nestedRecord(values: Record<string, Record<string, number>>) {
  return values;
}

export function rootKeyRecord(__di_key: Record<string, number>) {
  return __di_key;
}

type SpecialKeyRecord = Record<'' | '__id', number>;

export function specialKeyRecord(special: SpecialKeyRecord) {
  return special;
}

type CallableIntersection = ((input: string) => string) & { label: string };
type ConstructableIntersection = (new (value: string) => { value: string }) & { label: string };

export function callableIntersection(callable: CallableIntersection) {
  return callable;
}

export function constructableIntersection(constructable: ConstructableIntersection) {
  return constructable;
}

interface RecursiveValue {
  value: number;
  next?: RecursiveValue;
}

export function recursiveValue(value: RecursiveValue) {
  return value;
}

interface RequiredRecursiveValue {
  next: RequiredRecursiveValue;
}

export function requiredRecursiveValue(requiredRecursive: RequiredRecursiveValue) {
  return requiredRecursive;
}

type RecursiveIndexValue = { [key: string]: RecursiveIndexValue };

export function recursiveIndexValue(recursiveIndex: RecursiveIndexValue) {
  return recursiveIndex;
}

export function optionalObject(value: { label?: string }) {
  return value;
}

export function unsupportedNumberIndex(numericValues: { [key: number]: number }) {
  return numericValues;
}

export function unsupportedSymbolIndex(symbolValues: { [key: symbol]: number }) {
  return symbolValues;
}

export function unsupportedRecordValues(unsupportedValues: Record<string, Date>) {
  return unsupportedValues;
}

export function sum(...values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}

export function destructuredValues({ id, name }: User, [count, label]: [number, string]) {
  return { id, name, count, label };
}

export function nestedDestructured({ user: { id } }: { user: User }) {
  return id;
}
