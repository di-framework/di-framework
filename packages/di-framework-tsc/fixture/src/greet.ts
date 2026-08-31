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

export const divide = function (value: number, by: number): number {
  return value / by;
};

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

export function unionValues(value: string | number, nullable: string | null, result: Success | Failure) {
  return { value, nullable, result };
}

export function arrayValues(numbers: number[], users: ReadonlyArray<User>) {
  return { numbers, users };
}

export function tupleValues(pair: [number, string], nested: [string, User], optional: [number, string?]) {
  return { pair, nested, optional };
}

export function optionalValues(required: number, label?: string, count: number = 1) {
  return { required, label, count };
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
