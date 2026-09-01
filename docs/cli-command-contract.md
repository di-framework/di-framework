# Unified CLI command contract

`di-framework` is the project's only public command-line interface. Feature packages expose typed,
CLI-independent APIs; `@di-framework/cli` owns argument parsing, command routing, terminal presentation,
and process exit status.

## Canonical command tree

```text
di-framework
├── init
├── build
├── check
├── generate
├── skills
│   ├── index
│   │   ├── build
│   │   ├── inspect
│   │   ├── validate
│   │   ├── query
│   │   └── migrate
│   └── validate
├── http
│   └── openapi
│       └── generate
├── agent
│   ├── inspect
│   ├── audit
│   ├── init
│   └── migrate
└── mx
    ├── build
    ├── test
    ├── typecheck
    └── publish
```

This tree is exhaustive. There are no public command aliases, deprecated routes, or package-specific
alternatives. In particular, maintainer commands are available only below `di-framework mx`; feature
packages must not publish their own executable or accept command-line arguments in domain APIs.

## Naming and help

- Command names are lowercase English words in `kebab-case`. Use nouns for groups and imperative verbs
  for operations.
- `di-framework help`, `di-framework --help`, and `di-framework -h` show root help. Every command group
  and leaf accepts `help`, `--help`, or `-h` and shows help for that node.
- Help is written to standard output when explicitly requested and includes usage, available children or
  options, and a short description. An incomplete command group or invocation writes its help to standard
  error and reports invalid usage.
- Unknown commands, unknown options, missing option values, and extra positional arguments identify the
  invalid token and show the nearest relevant help. Parsers must not silently ignore arguments.
- Global `--json` is accepted before or after the command path. Command-specific options otherwise follow
  the complete command path.

## Output and errors

- Normal text and explicitly requested help go to standard output. Progress and diagnostics that are part
  of a successful text response also go to standard output. Errors go to standard error.
- JSON mode writes exactly one JSON value followed by a newline to standard output and no presentation
  text. The value is an object with `schemaVersion`, `command`, `ok`, and `data` fields. `schemaVersion` is
  `1`; `command` is the canonical space-separated command path; `data` is the typed package result or a
  command-specific object documented by that command.
- A JSON failure uses the same envelope with `ok: false`, omits `data`, and adds `error` with stable
  `code`, human-readable `message`, and optional JSON-compatible `details`. It is written to standard
  output so automation has one parseable channel; unexpected internal diagnostics may additionally be
  written to standard error.
- JSON property names and enum values are stable API. Output is serialized with `JSON.stringify`; no
  colors, icons, or environment-dependent formatting are emitted in JSON mode.

## Exit status

| Status | Meaning |
| ------ | ------- |
| `0` | Command completed successfully, including explicitly requested help. |
| `1` | The operation completed with a negative domain result, such as validation findings or drift. |
| `2` | Invalid command usage or configuration. |
| `3` | An unexpected execution, filesystem, or dependency failure prevented a result. |

Command handlers return typed results or throw typed command failures. They never call `process.exit()`,
write through global `console`, or translate domain results into exit codes. The executable boundary alone
renders the result and assigns `process.exitCode` from this table.

## Ownership boundary

| Layer | Owns | Must not own |
| ----- | ---- | ------------ |
| Feature packages | Domain validation and transformations, filesystem-neutral typed options and results, explicit write APIs, and progress callbacks | Argument parsing, terminal formatting, process globals, or exit status |
| `@di-framework/cli` command handlers | Mapping parsed arguments to package options and mapping typed results to command presentation models | Copied validation, indexing, generation, audit, migration, or other domain algorithms |
| `@di-framework/cli` infrastructure | Nested dispatch, help, injectable I/O, stable JSON envelopes, typed command failures, and centralized exit translation | Feature-specific business rules |

Command tests must substitute or spy on the package API boundary and prove delegation. If a feature cannot
be invoked without duplicating package internals, its package API must be extended first.
