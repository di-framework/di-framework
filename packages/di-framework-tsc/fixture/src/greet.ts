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
