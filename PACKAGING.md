# Publishing policy and audit

All published `@di-framework/*` packages use explicit `files` allowlists. Runtime
libraries publish compiled JavaScript and declarations from `dist`, plus their
README and required license or migration files. Export conditions must target
files present in the tarball, and published dependency fields must use registry
semver ranges rather than monorepo-only `workspace:` protocols.

## Reviewed allowlists

| Package | Published files | Classification |
| --- | --- | --- |
| `core` | `dist`, README, licenses, migration guide | runtime |
| `repo`, `http`, `graphql`, `events`, `config`, `auth`, `authz`, `socket`, `rpc`, `codegen`, `ai-utils` | `dist`, README | runtime |
| `ai` | `src`, README | intentional TypeScript source package |
| `cli` | `main.ts`, `cmd`, `scripts`, README | intentional Bun source CLI |
| `tsc` | `bin`, `plugin.cjs`, `plugin`, README, licenses | compiler plugin and Go sidecars |

Runtime source maps are not published, so tarballs do not duplicate
`sourcesContent`. The three source/plugin exceptions are required because Bun
executes the AI and CLI TypeScript entry points directly and the transformer
loads its JavaScript plugin plus platform sidecars.

## Recorded audit results

The implementation merged in PR #168 reduced runtime tarballs by 12.8–43.8%
packed and 32.3–48.2% unpacked, depending on package. Source-package exceptions
were unchanged. The current audit prints packed bytes, unpacked bytes, and entry
counts for every package on every CI run so later changes remain reviewable.

Run `bun run build && bun run check-packaging`. The audit packs every public
workspace with `npm pack`, reads the packed `package.json`, and fails for:

- missing `main`, `module`, `types`, export, or binary targets;
- tests, examples, or unapproved raw TypeScript in a tarball;
- unresolved `workspace:` versions in dependencies, optional dependencies, or
  peer dependencies;
- internal `@di-framework/*` ranges in those fields that do not accept the
  release version (workspace root `package.json` version, or
  `DI_RELEASE_VERSION` when set). A `5.2.0` release must ship compatible
  ranges such as `^5`, not a stale `^4`.

Release runs `bun scripts/prepare-publish-manifests.ts` before the pack audit
and publish. That step rewrites `workspace:*` / `workspace:^` and any stale
internal range to `^<major>` derived from the version being released. Intentional
cross-major relationships must be listed in
`INTERNAL_CROSS_MAJOR_ALLOWLIST` in `scripts/internal-framework-deps.ts` as
`@di-framework/consuming>@di-framework/dependency` and documented here when
added.

GraphQL's dist-compatibility tests additionally exercise decorator registration
from compiled artifacts in Bun and Node ESM. Declaration builds cover every
documented subpath; CLI, codegen, and transformer assets remain explicit
exceptions in the table above.
