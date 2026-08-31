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
