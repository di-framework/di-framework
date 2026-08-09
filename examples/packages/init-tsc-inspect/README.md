# init-tsc-inspect

di-framework application scaffolded with `di-framework init`.

Includes [`@di-framework/tsc`](https://www.npmjs.com/package/@di-framework/tsc) for emit-time runtime parameter checks (`ttsc`). The first `ttsc` build compiles a Go sidecar (needs a Go toolchain; see [ttsc](https://ttsc.dev)).

## Setup

```bash
bun install
bun run dev
```

## Scripts

| Script    | Description |
| --------- | ----------- |
| `dev`   | Run `src/index.ts` with Bun (no emit; runtime checks not injected) |
| `build` | `di-framework build` → `ttsc --emit` (injects runtime checks) |
| `start` | Run emitted `dist/index.js` |
| `check` | `di-framework check` → `ttsc --noEmit` |

## Learn more

- [Documentation](https://docs.di-framework.dev)
- [Runtime type checks](https://docs.di-framework.dev/tsc.html)
- Add packages: `bun add @di-framework/http` (or graphql, auth, config, …)
