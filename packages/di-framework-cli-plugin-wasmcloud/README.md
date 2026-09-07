# @di-framework/cli-plugin-wasmcloud

di-framework CLI extension for targeting [wasmCloud](https://wasmcloud.com): build a DI Framework
HTTP app into a WASI 0.3 WebAssembly component, serve it locally, and deploy it from a workspace
manifest.

```bash
di-framework extensions install wasmcloud

di-framework wasmcloud build                         # bundle + jco componentize → dist/<name>.wasm
di-framework wasmcloud dev                           # build, then serve locally (wasmtime by default)
di-framework wasmcloud deploy                        # nearest project, default target
di-framework wasmcloud deploy greeter                # named project anywhere in the workspace
di-framework wasmcloud deploy greeter --target development
di-framework wasmcloud destroy greeter
di-framework wasmcloud platform init                 # generate deploy/platform + local target
di-framework wasmcloud platform deploy local --yes   # start the generated platform
di-framework wasmcloud platform destroy local --yes
di-framework wasmcloud doctor                        # project + toolchain readiness checks
```

Run these commands directly. Do not wrap them in `package.json` scripts.

## Project convention

A component project is marked by `di-framework.config.json`:

```json
{ "name": "my-app", "entry": "src/app.ts", "output": "dist/my-app.wasm" }
```

Named wasmCloud host-interface bindings live in `src/bindings.ts` (override with `"bindings"`).
Each exported class extending a `@di-framework/wasmcloud` base and decorated with
`@WasmCloudBinding('name')` is discovered statically and added to the WIT requirement graph.
The binding name becomes the labeled WIT import and `hostInterfaces[].name`. Secret values are
never taken from source; `secretFrom` defaults to `<application>-<binding>`.

The configured `name` is the only project identity. The extension owns the WebAssembly/WASI
boundary: it records WIT requirements (the HTTP adapter exports `wasi:http/handler@0.3.0` today),
generates one world and a `wit.lock.json` from that graph, bundles the entry behind a WASI-HTTP ↔
Web Fetch adapter, and componentizes with `jco --backend qjs`. Build state lives in the disposable
`.di-framework/` directory. Package versions are independent of the component-model preview: a WASI
0.3 guest may still import `wasmcloud:*` packages at their own versions.

Local `wasmcloud dev` uses `wasmtime serve` when wasmtime 46+ is on PATH, then `wash dev`, then
`jco serve`. Set `DI_FRAMEWORK_WASMCLOUD_DEV_RUNNER` to `wasmtime`, `wash`, or `jco` to pin one.

## Deployment manifest

Deployment topology lives in `di-framework.deploy.toml` at the workspace root. The CLI finds it by
walking upward from the current directory. The file describes **targets**, not applications: there
is no `apps` table, and projects may live in any directory layout.

```toml
default-target = "local"

[targets.local]
platform = "deploy/platform"
stack = "dev"

[targets.development]
kubeconfig = "${KUBECONFIG}"
context = "team-development"
namespace = "wasmcloud"

[targets.development.registry]
push = "https://registry.example.com/team"
pull = "registry.internal.example.com/team"
insecure = false
```

- `di-framework wasmcloud deploy` with no name uses the nearest `di-framework.config.json`.
- `di-framework wasmcloud deploy greeter` recursively discovers projects (skipping `.git`,
  `node_modules`, `.di-framework`, and generated output by default) and matches the configured
  `name`. Duplicate names fail with every conflicting path.
- `${VAR}` interpolation fails if the variable is unset or empty. Do not put credentials in the
  manifest.

### Managed Pulumi target

From the workspace root, generate a self-contained local platform (k0s, a local OCI registry, and
the wasmCloud operator) from templates shipped with this extension:

```bash
di-framework wasmcloud platform init
di-framework wasmcloud platform deploy local --yes
```

`platform init` writes `deploy/platform` and creates or updates `di-framework.deploy.toml` so
`local` is a managed target (`platform = "deploy/platform"`, `stack = "dev"`). Existing files are
left alone unless you pass `--force`. The command prints the exact start command when it finishes.
Platform deploy runs the package-manager-neutral `pulumi install` command automatically, so the
generated project works immediately in a blank consumer workspace without a root workspace entry
or a manual install inside `deploy/platform`.

The generated Pulumi project provisions only platform concerns. It has workspace- and stack-scoped
Docker names, a dedicated network, persistent k0s state/log volumes, pinned images and chart,
readiness checks, and loopback-only high ports. It must not contain application names, component
builds, application Services, or WorkloadDeployments. The defaults are Kubernetes `26443`, registry
`25000`, and HTTP `28180`; set `apiPort`, `registryPort`, or `httpPort` with `pulumi config set` in
`deploy/platform` to choose another distinct port from 1024 through 65535.

The CLI reads a small output contract from `pulumi stack output --json`:

| Output | Required | Meaning |
| --- | --- | --- |
| `kubeconfig` | yes | kubeconfig YAML or a filesystem path |
| `namespace` | yes | Kubernetes namespace for workloads |
| `registry` | yes | legacy string shorthand, or `{ push, pull, insecure }` transport object |
| `context` | no | kubectl context |
| `endpoints.http` / `endpoints.kubernetes` / `endpoints.registry` | no | optional URLs |

Provision and tear down that stack explicitly:

```bash
di-framework wasmcloud platform deploy local --yes
di-framework wasmcloud platform destroy local --yes
```

Application `destroy` never runs `pulumi destroy`.

The generated local target publishes through its loopback registry NodePort and puts the equivalent
in-cluster registry address in the WorkloadDeployment. Both references use the same repository and
stable canonical-input tag. An `http://` push URL or `insecure = true` adds ORAS `--plain-http` only
for that target; TLS remains the default everywhere else.

### Existing cluster

When kubeconfig and a registry are already available, declare an external target with only access
information (as `development` above) and deploy:

```bash
export KUBECONFIG="$HOME/.kube/config"
di-framework wasmcloud deploy greeter --target development
```

## Application deploy

For the selected project the extension:

1. Builds the component.
2. Publishes it with `oras` from the project root using project-relative artifact paths and a stable
   canonical-input reference (`<registry>/<wit-name>:sha256-<deployment-digest>`). The actual
   component-byte digest is calculated and reported separately because ComponentizeJS snapshots may
   vary byte-for-byte for identical inputs.
3. Derives a wasmCloud `WorkloadDeployment` and Kubernetes `Service` (written under `.di-framework/deploy/`, not checked in).
4. Configures `wasi:http/handler@0.3.0` with the project name as its host, applies the resources,
   and waits for current `Ready=True` or compatible older readiness schemas.

For the generated local platform the result reports the HTTP URL and required Host header. It is
directly reachable without `kubectl port-forward`, for example:

```sh
curl -H 'Host: greeter' http://127.0.0.1:28180/
```

## Demonstration layout

A complete workspace is in [`examples/workspace`](./examples/workspace): `deploy/platform` plus
projects at `services/greeter` and `nested/deep/echo`. Copy that tree or start from the TOML
above.

The manifest contract for extensions is documented in
[`@di-framework/cli-extension`](https://www.npmjs.com/package/@di-framework/cli-extension).

## Live integration test

The opt-in test packs the CLI and extension dependencies, installs those tarballs in a blank
temporary workspace, and runs the full platform/application lifecycle against Docker:

```sh
DI_FRAMEWORK_WASMCLOUD_LIVE=1 bun test packages/di-framework-cli-plugin-wasmcloud/tests/live-workflow.test.ts
```

It requires Docker, Pulumi, kubectl, ORAS, npm, Bun, and curl. The test selects unused loopback
ports and removes its scoped platform resources in a `finally` cleanup.
