# Runtime type checks

`@di-framework/tsc` is a [`ttsc`](https://ttsc.dev) transform that injects **runtime parameter checks** from your TypeScript types.

Source stays plain TypeScript — no `assert()`, schemas, or decorators. On emit, function bodies get `typeof`, equality, and shape guards synthesized from parameter types.

Function declarations and expressions, arrows (including concise and async arrows), methods, and constructors are supported.

`di-framework init` wires this by default (`@di-framework/tsc` and `plugins` in `tsconfig`; `ttsc` and TypeScript 7+ come with `@di-framework/tsc`). Use the steps below for an existing app.

## Installation

```bash
npm i -D @di-framework/tsc
```

Pulls in `ttsc` and TypeScript 7+ transitively.

The first build compiles a Go sidecar (cached afterward). Needs a Go toolchain (`go` 1.26+ recommended; `ttsc` can pin via `TTSC_GO_BINARY`).

## Setup

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "strict": true,
    "plugins": [{ "transform": "@di-framework/tsc" }]
  }
}
```

The package also declares `ttsc.plugin` for auto-discovery when listed in `devDependencies`. Explicit `plugins[]` is recommended so wiring is obvious.

Build with `ttsc`, not stock `tsc`:

```bash
npx ttsc --emit
```

## Example

```typescript
interface User {
  id: number;
  name: string;
}

function greet(user: User): string {
  return `hello ${user.name}`;
}
```

Emitted JavaScript (simplified):

```javascript
function greet(user) {
  if (typeof user !== "object" || user === null)
    throw new TypeError("Expected user to be an object");
  if (typeof user.id !== "number")
    throw new TypeError("Expected user.id to be a number");
  if (typeof user.name !== "string")
    throw new TypeError("Expected user.name to be a string");
  return `hello ${user.name}`;
}
```

## How it works

1. `ttsc` loads the program (parse + typecheck).
2. The plugin walks functions, arrows, methods, and constructors.
3. For each required parameter, it reads the type (syntax keywords, else checker).
4. It synthesizes `if` / `throw` AST nodes and prepends them to the body.
5. Emit prints JavaScript from the mutated AST.

## Supported boundaries and types

The transformer handles function declarations/expressions, methods, constructors, and block- or expression-bodied arrows at any nesting level. Required, optional, default, rest, and simple destructured parameters are supported. Runtime predicates cover primitives, nullish and literal types, enums, accessible local class instances, sound bounded unions, plain structural objects, non-callable object-only intersections, erased primitive brands, template-literal strings, string index signatures, `Record<string, V>` and literal-key records, arrays/readonly arrays, and fixed tuples with optional tails.

## Limitations

Unsupported paths are skipped as a whole rather than emitting a predicate that can reject valid input. Current intentional gaps are:

- defaults and rest elements nested inside destructuring patterns
- variadic tuples, imported class bindings, callable/constructable intersections, typia-style tags, and custom nominal predicates
- number-only and symbol index signatures, and advanced mapped/conditional types
- unions with unsupported members or more than 12 members
- `void`, `never`, and `unique symbol`

Arrays and `ReadonlyArray<T>` are checked with `Array.isArray` and a full element scan.
Fixed tuples enforce their allowed length and validate each position; optional tails are presence-gated.
Object-only intersections use the checker's flattened apparent properties, validating each required property once. Required properties are checked for presence before their value, including properties whose type admits `undefined`; optional object properties remain unchecked.
String index signatures and `Record<string, V>` scan every own enumerable string-keyed value with `Object.keys`. Literal-key records instead check each required key, including names that require bracket access.
Primitive intersections used as brands validate only their string, number, boolean, bigint, or literal runtime representation. Recognized marker objects contain only computed unique-symbol properties, or conventional marker keys such as `__brand`, `_brand`, or `_tag` whose values are literals, unique symbols, or `never`. Brand marker properties are compile-time-only and are never read at runtime; class, callable, constructable, indexed, and ordinary structural intersections are not erased as brands. Enforcing application-specific brand semantics requires a future custom predicate facility.
Template-literal types always require a string. A template with one string-like placeholder also enforces its nonempty fixed prefix and suffix with `startsWith` and `endsWith`; multiple placeholders and non-string placeholders intentionally fall back to the string check.
Structural traversal keeps a per-path visited set and a maximum depth of eight, so recursive types cannot hang compilation.
Optional and defaulted parameters are validated only when their runtime value is not `undefined`; `null` is still checked against the declared type.
Rest parameters use the same full array and element validation as ordinary arrays.
Simple object, array, and nested destructured bindings are validated using the types of the bound identifiers.

Numeric, string, and const enums are checked against their checker-known member values. Enums with a computed member are skipped as a whole because the computed runtime value cannot be reproduced soundly without depending on an emitted enum object.
Class-typed parameters use `instanceof` when the checker can name an accessible local or local-namespace runtime constructor; interfaces remain structural. Subclasses pass the check, and generic type arguments are erased at runtime. As with any `instanceof` test, equivalent instances created in another JavaScript realm do not pass. ES-imported class bindings are conservatively skipped, including ordinary value imports, because TypeScript can elide an import used only as a type and the transformer does not synthesize or retain imports.

## Monorepo note

`@di-framework/tsc` is isolated from the monorepo’s TypeScript 5.x `tsc` graph (package `build` is a no-op). `ttsc` and TypeScript 7+ are dependencies of `@di-framework/tsc` (kept out of root / other `@di-framework/*` packages).

## Next Steps

- [CLI](cli.md) - App `init` / `check` / `build` and maintainer `mx`
- [Installation](installation.md) - Core package setup
- [Best Practices](best-practices.md) - Recommended patterns
