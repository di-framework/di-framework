# Code Coverage & Package Metrics

This document outlines the code coverage policy, metric calculation methodology, package inclusion/exclusion rules, and per-package metrics for `@di-framework`.

## Overview

`di-framework` enforces strict code quality and coverage transparency:
1. **100% Line Coverage Enforcement**: All measured TypeScript production source files in `packages/` must maintain 100% line coverage (`scripts/check-line-coverage.ts`).
2. **Coverage Mapping Verification**: Every published `@di-framework/*` package in `packages/` must be mapped in the coverage tracking system (`scripts/check-coverage-mapping.ts`).
3. **Dynamic Badges**: Root `README.md` uses dynamic Shields.io endpoint badges (`coverage/badges/<slug>.json`) to display real-time per-package coverage without committing `README.md` diffs on every CI run.

---

## Included & Excluded Code

### Included Source Code
- All production `.ts`, `.tsx`, and `.js` source files within `packages/di-framework-<pkg>/` directories.

### Excluded Code
- **Tests**: `**/tests/**`, `**/*.test.ts`, `**/*.spec.ts`
- **Build Output**: `**/dist/**`
- **Mocks**: `**/preload-wasm-mock.ts`
- **Scripts & Maintenance**: `**/scripts/**`
- **Examples**: `examples/`
- **Non-TypeScript / External Runtimes**: Packages containing non-TypeScript runtimes or CJS script wrappers not instrumented by the Bun TypeScript LCOV collector (e.g. `@di-framework/tsc` which contains Go plugin code in `plugin/main.go` and CJS script wrappers).

---

## Metric Computation

- **Instrumented Lines ($LF$)**: Total lines of code in production source files identified by the LCOV parser.
- **Lines Hit ($LH$)**: Total instrumented lines executed during `bun test --coverage`.
- **Line Coverage Percentage**:
  $$\text{Line Coverage} = \left(\frac{LH}{LF}\right) \times 100\%$$
- **Unmeasured / N/A Status**: Packages without measured TypeScript source files are explicitly labeled as `N/A` (with `lightgrey` badges) to ensure honest reporting rather than inheriting aggregate defaults.

---

## Per-Package Coverage Table

| Package | Slug | Status | Line Coverage | Description | Details |
| --- | --- | --- | --- | --- | --- |
| `@di-framework/core` | `core` | Measured | 100% | DI container and decorators | [#di-frameworkcore](#di-frameworkcore) |
| `@di-framework/cli` | `cli` | Measured | 100% | App CLI: `init`, `build`, `check`, `mx` | [#di-frameworkcli](#di-frameworkcli) |
| `@di-framework/codegen` | `codegen` | Measured | 100% | Code generation engine for schema manifests | [#di-frameworkcodegen](#di-frameworkcodegen) |
| `@di-framework/tsc` | `tsc` | Unmeasured | N/A (Go / CJS) | `ttsc` runtime parameter checks | [#di-frameworktsc](#di-frameworktsc) |
| `@di-framework/repo` | `repo` | Measured | 100% | Data access / repositories | [#di-frameworkrepo](#di-frameworkrepo) |
| `@di-framework/http` | `http` | Measured | 100% | HTTP routing and OpenAPI | [#di-frameworkhttp](#di-frameworkhttp) |
| `@di-framework/graphql` | `graphql` | Measured | 100% | GraphQL schema from domain objects | [#di-frameworkgraphql](#di-frameworkgraphql) |
| `@di-framework/events` | `events` | Measured | 100% | Kafka / NATS / memory event bridge | [#di-frameworkevents](#di-frameworkevents) |
| `@di-framework/config` | `config` | Measured | 100% | Typed config from env/files via DI | [#di-frameworkconfig](#di-frameworkconfig) |
| `@di-framework/auth` | `auth` | Measured | 100% | Sessions, JWT, OAuth2/OIDC, WebAuthn | [#di-frameworkauth](#di-frameworkauth) |
| `@di-framework/authz` | `authz` | Measured | 100% | Declarative resource policies | [#di-frameworkauthz](#di-frameworkauthz) |
| `@di-framework/socket` | `socket` | Measured | 100% | WebSocket / TCP / UDP WebCrypto channel | [#di-frameworksocket](#di-frameworksocket) |
| `@di-framework/rpc` | `rpc` | Measured | 100% | JSON-RPC and Connect protocol | [#di-frameworkrpc](#di-frameworkrpc) |
| `@di-framework/ai` | `ai` | Measured | 100% | Chat, tools, RAG, MCP, agents | [#di-frameworkai](#di-frameworkai) |

---

## Package Details

<a id="di-frameworkcore"></a>
### `@di-framework/core`
- **Location**: [`packages/di-framework-core`](packages/di-framework-core)
- **Description**: Dependency injection container, singleton/transient scope management, decorator registry, and lifecycle management.
- **Coverage Requirement**: Measured (100% line coverage enforced).

<a id="di-frameworkcli"></a>
### `@di-framework/cli`
- **Location**: [`packages/di-framework-cli`](packages/di-framework-cli)
- **Description**: Command-line interface for scaffolding, building, checking, and maintaining applications.
- **Coverage Requirement**: Measured (100% line coverage enforced).

<a id="di-frameworkcodegen"></a>
### `@di-framework/codegen`
- **Location**: [`packages/di-framework-codegen`](packages/di-framework-codegen)
- **Description**: Code generation engine for container specs and dependency graphs.
- **Coverage Requirement**: Measured (100% line coverage enforced).

<a id="di-frameworktsc"></a>
### `@di-framework/tsc`
- **Location**: [`packages/di-framework-tsc`](packages/di-framework-tsc)
- **Description**: Runtime parameter assertion plugin.
- **Coverage Requirement**: Unmeasured (`N/A`). Contains Go runtime plugin source (`plugin/main.go`) and CJS script wrappers (`plugin.cjs`, `bin/dtsc.cjs`) which are not instrumented by the Bun TypeScript test runner.

<a id="di-frameworkrepo"></a>
### `@di-framework/repo`
- **Location**: [`packages/di-framework-repo`](packages/di-framework-repo)
- **Description**: Data access layer supporting SQLite, Cloudflare D1, and in-memory repositories.
- **Coverage Requirement**: Measured (100% line coverage enforced).

<a id="di-frameworkhttp"></a>
### `@di-framework/http`
- **Location**: [`packages/di-framework-http`](packages/di-framework-http)
- **Description**: HTTP routing engine and OpenAPI 3.0 specification generation.
- **Coverage Requirement**: Measured (100% line coverage enforced).

<a id="di-frameworkgraphql"></a>
### `@di-framework/graphql`
- **Location**: [`packages/di-framework-graphql`](packages/di-framework-graphql)
- **Description**: Automatic GraphQL schema generation from decorated domain models.
- **Coverage Requirement**: Measured (100% line coverage enforced).

<a id="di-frameworkevents"></a>
### `@di-framework/events`
- **Location**: [`packages/di-framework-events`](packages/di-framework-events)
- **Description**: In-memory and external event message brokers (Kafka and NATS).
- **Coverage Requirement**: Measured (100% line coverage enforced).

<a id="di-frameworkconfig"></a>
### `@di-framework/config`
- **Location**: [`packages/di-framework-config`](packages/di-framework-config)
- **Description**: Strongly typed configuration loading from environment variables, JSON, and Zod schemas.
- **Coverage Requirement**: Measured (100% line coverage enforced).

<a id="di-frameworkauth"></a>
### `@di-framework/auth`
- **Location**: [`packages/di-framework-auth`](packages/di-framework-auth)
- **Description**: Authentication provider framework, JWT tokens, OAuth2/OIDC server, and WebAuthn assertions.
- **Coverage Requirement**: Measured (100% line coverage enforced).

<a id="di-frameworkauthz"></a>
### `@di-framework/authz`
- **Location**: [`packages/di-framework-authz`](packages/di-framework-authz)
- **Description**: Policy evaluation engine for role-based and dynamic authorization rules.
- **Coverage Requirement**: Measured (100% line coverage enforced).

<a id="di-frameworksocket"></a>
### `@di-framework/socket`
- **Location**: [`packages/di-framework-socket`](packages/di-framework-socket)
- **Description**: Low-latency WebSocket, TCP, UDP transport, and WebCrypto encrypted wire sessions.
- **Coverage Requirement**: Measured (100% line coverage enforced).

<a id="di-frameworkrpc"></a>
### `@di-framework/rpc`
- **Location**: [`packages/di-framework-rpc`](packages/di-framework-rpc)
- **Description**: JSON-RPC server/client and Connect protocol implementation.
- **Coverage Requirement**: Measured (100% line coverage enforced).

<a id="di-frameworkai"></a>
### `@di-framework/ai`
- **Location**: [`packages/di-framework-ai`](packages/di-framework-ai)
- **Description**: AI model clients, tool calling, RAG pipelines, Model Context Protocol (MCP), and graph agent workflows.
- **Coverage Requirement**: Measured (100% line coverage enforced).

---

## Local Verification Commands

```bash
# Run unit test suite and generate LCOV coverage report
bun test --coverage

# Enforce 100% line coverage on reported TypeScript source files
bun scripts/check-line-coverage.ts

# Verify coverage package mapping completeness
bun scripts/check-coverage-mapping.ts

# Generate dynamic badge JSON files for Shields.io endpoint API
bun scripts/generate-coverage-badges.ts
```
