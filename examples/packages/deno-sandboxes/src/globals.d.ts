declare module '@std/assert' {
  export function assertEquals(actual: any, expected: any, msg?: string): void;
}

declare const Deno: any;

interface ImportMeta {
  main: boolean;
}
