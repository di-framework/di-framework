# @di-framework Packaging Policy & Audit

This document outlines the packaging policy, file allowlists, exceptions, before/after statistics, and verification methods for all 14 published `@di-framework/*` packages.

---

## 1. Packaging Policy

All runtime packages under `packages/` adhere to strict published artifact controls:
- **Built Artifacts Only**: Runtime packages publish built JavaScript bundles and `.d.ts` declaration files under `dist/`.
- **Export Conditions Standardization**: Every export subpath in `package.json` specifies standard condition keys pointing to built `dist/` JS artifacts and type declarations:
  ```json
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "bun": "./dist/index.js",
      "import": "./dist/index.js",
      "default": "./dist/index.js"
    }
  }
  ```
- **Node ESM Compatibility**: Relative imports within compiled artifacts and TS declaration entry points include `.js` file extensions for native Node ESM resolution.
- **Source & Test Stripping**: Raw TypeScript implementation source files (`*.ts`, `src/`), test files (`*.test.ts`, `tests/`), and example directories (`examples/`) are excluded from published tarballs to reduce package footprint and enforce clean runtime boundaries.

---

## 2. Package Classification & File Allowlists

| Package Name | Category | `files` Allowlist | Notes / Exceptions |
| --- | --- | --- | --- |
| `@di-framework/core` | Runtime Library | `["dist", "README.md", "LICENSE*", "MIGRATION_GUIDE.md"]` | Built TS container framework |
| `@di-framework/repo` | Runtime Library | `["dist", "README.md"]` | Storage adapters & repository abstractions |
| `@di-framework/http` | Runtime Library | `["dist", "README.md"]` | HTTP server & routing decorators |
| `@di-framework/graphql` | Runtime Library | `["dist", "README.md"]` | Semantic GraphQL schema graph generator |
| `@di-framework/events` | Runtime Library | `["dist", "README.md"]` | Memory, Kafka, and NATS event buses |
| `@di-framework/config` | Runtime Library | `["dist", "README.md"]` | Zod & environment configuration loader |
| `@di-framework/auth` | Runtime Library | `["dist", "README.md"]` | WebAuthn, OAuth, session authentication |
| `@di-framework/authz` | Runtime Library | `["dist", "README.md"]` | EBNF authorization policy engine |
| `@di-framework/socket` | Runtime Library | `["dist", "README.md"]` | Node/Bun/Worker WebSocket transport |
| `@di-framework/rpc` | Runtime Library | `["dist", "README.md"]` | Memory, HTTP, Socket & gRPC RPC layer |
| `@di-framework/codegen` | Runtime Library | `["dist", "README.md"]` | Schema code emitter |
| `@di-framework/ai` | Source Package | `["src", "README.md"]` | **Special Exception**: Source-only TS AI agent framework |
| `@di-framework/cli` | Source CLI | `["main.ts", "cmd", "scripts", "README.md"]` | **Special Exception**: Source executable bin CLI |
| `@di-framework/tsc` | Compiler Plugin | `["bin", "plugin.cjs", "plugin", "README.md", "LICENSE*"]` | **Special Exception**: ttsc plugin & Go sidecar binaries |

---

## 3. Before vs After Packaging Audit Statistics

| Package Name | Packed (Before) | Packed (After) | Unpacked (Before) | Unpacked (After) | Entries (Before) | Entries (After) | Size Reduction |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `@di-framework/core` | 24.9 KB | **21.7 KB** | 122.9 KB | **82.7 KB** | 46 | **27** | -12.8% packed / -32.6% unpacked |
| `@di-framework/repo` | 32.2 KB | **21.1 KB** | 135.1 KB | **77.4 KB** | 32 | **22** | -34.4% packed / -42.6% unpacked |
| `@di-framework/http` | 22.6 KB | **12.7 KB** | 117.1 KB | **68.4 KB** | 24 | **11** | -43.8% packed / -41.6% unpacked |
| `@di-framework/graphql` | 89.4 KB | **57.2 KB** | 408.6 KB | **238.6 KB** | 34 | **19** | -36.0% packed / -41.6% unpacked |
| `@di-framework/events` | 20.2 KB | **12.7 KB** | 89.8 KB | **50.4 KB** | 30 | **18** | -37.1% packed / -43.9% unpacked |
| `@di-framework/config` | 11.3 KB | **8.1 KB** | 46.6 KB | **25.8 KB** | 32 | **18** | -28.3% packed / -44.6% unpacked |
| `@di-framework/auth` | 213.6 KB | **130.8 KB** | 912.7 KB | **512.0 KB** | 160 | **84** | -38.7% packed / -43.9% unpacked |
| `@di-framework/authz` | 17.3 KB | **10.9 KB** | 75.3 KB | **40.0 KB** | 25 | **15** | -37.0% packed / -46.8% unpacked |
| `@di-framework/socket` | 89.7 KB | **63.5 KB** | 425.8 KB | **288.5 KB** | 39 | **39** | -29.2% packed / -32.3% unpacked |
| `@di-framework/rpc` | 65.7 KB | **44.2 KB** | 337.1 KB | **219.8 KB** | 45 | **26** | -32.7% packed / -34.8% unpacked |
| `@di-framework/ai` | 114.6 KB | **114.6 KB** | 479.8 KB | **479.8 KB** | 140 | **140** | (Source package, unchanged) |
| `@di-framework/codegen` | 18.9 KB | **11.3 KB** | 93.2 KB | **48.3 KB** | 29 | **16** | -40.2% packed / -48.2% unpacked |
| `@di-framework/cli` | 11.3 KB | **11.3 KB** | 40.6 KB | **40.7 KB** | 13 | **13** | (CLI source bin, unchanged) |
| `@di-framework/tsc` | 11.1 KB | **11.1 KB** | 32.4 KB | **32.4 KB** | 9 | **9** | (Go sidecar/plugin, unchanged) |

---

## 4. Verification Methods & CI Enforcement

Packaging integrity is validated across three verification layers:

1. **Automated CI Tarball Audit**:
   `scripts/check-package-tarballs.ts` validates all 14 published packages via `npm pack --dry-run --json`:
   - Verifies all `main`, `module`, `types`, and `exports` subpaths exist in the packed file set.
   - Verifies no forbidden test files (`*.test.ts`, `tests/`), examples (`examples/`), or raw TS implementation files exist in runtime packages.
   - Run manually via:
     ```bash
     bun run check-packaging
     # or
     bun scripts/check-package-tarballs.ts
     ```

2. **Runtime Dist Compatibility Suite**:
   `packages/di-framework-graphql/tests/dist-compatibility.test.ts` imports built `dist/` artifacts directly into both Bun and Node (`node` ESM child process) to ensure decorator APIs (`@SemanticType`, `@Portal`, `@Field`, `@Arg`, `@Action`, `@Lookup`, `@Injectable`) and subpath exports execute cleanly.

3. **Type Declaration Resolution**:
   Ensures `.d.ts` declaration files exist for every public and subpath export condition across all published packages.
