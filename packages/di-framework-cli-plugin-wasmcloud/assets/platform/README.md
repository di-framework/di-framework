# Local wasmCloud platform

This generated Pulumi project provisions platform resources only:

- a pinned k0s controller/worker in a stack- and workspace-scoped Docker network;
- stack-scoped Docker volumes for k0s state and pod logs;
- an in-cluster, pinned OCI registry exposed to the host only through loopback;
- wasmCloud runtime operator 2.8.0 and its default HTTP host group;
- a generic loopback HTTP entrypoint.

This program also installs the deploy-controller WorkloadDeployment (Host
`deploy`). Application `WorkloadDeployment`s are written only by that
controller after `di-framework wasmcloud login`.

`di-framework wasmcloud platform deploy local --yes` runs `pulumi install`
before selecting the stack, so this directory does not need a manual package
manager install and does not need to belong to a root workspace.

## Ports

The safe high defaults bind only to `127.0.0.1`:

| Pulumi setting | Default | Purpose |
| --- | ---: | --- |
| `apiPort` | `26443` | Kubernetes API |
| `registryPort` | `25000` | host-side ORAS push endpoint |
| `httpPort` | `28180` | wasmCloud HTTP entrypoint |

Each must be a distinct integer from 1024 through 65535. Override one before
deployment from this directory, for example:

```sh
pulumi config set httpPort 28181
```

Internal NodePorts are fixed inside the isolated k0s container. The registry
push address (`http://127.0.0.1:25000` by default) and cluster pull address
(`di-framework-registry.wasmcloud.svc.cluster.local:5000`) reach the same
registry content.

## Output contract

| Output | Meaning |
| --- | --- |
| `schemaVersion` | output contract version (`2`) |
| `kubeconfig` | absolute path to a generated mode-0600 kubeconfig |
| `namespace` | Kubernetes namespace (`wasmcloud`) |
| `registry.push` | host-side registry URL used by ORAS |
| `registry.pull` | cluster-side registry address used by workloads |
| `registry.insecure` | whether ORAS must use plain HTTP |
| `endpoints.kubernetes` | loopback API server URL |
| `endpoints.registry` | loopback registry URL |
| `endpoints.http` | loopback HTTP URL |
| `controller.url` | deploy-controller HTTP URL (same loopback entrypoint) |
| `controller.host` | HTTP `Host` header (`deploy`) |

## Lifecycle

From the workspace root:

```sh
di-framework wasmcloud platform deploy local --yes
di-framework wasmcloud login
di-framework wasmcloud deploy <configured-project-name>
di-framework wasmcloud destroy <configured-project-name>
di-framework wasmcloud platform destroy local --yes
```

Local bootstrap login is `admin` / `local-admin` (override with Pulumi
`bootstrapPassword`). Send the configured project name as the HTTP `Host`
header, for example:

```sh
curl -H 'Host: greeter' http://127.0.0.1:28180/
```

Platform destroy removes only Docker and Kubernetes resources bearing this
project/stack scope, along with the generated kubeconfig. It refuses to adopt
or replace an already-existing Docker resource with the same name. Teardown
uses the `kubectl` bundled in the scoped k0s container, so no host-side
`kubectl` installation is needed for platform lifecycle commands.
