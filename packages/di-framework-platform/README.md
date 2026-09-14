# @di-framework/platform

Shared TypeScript/Pulumi infrastructure for the wasmCloud CLI extension and
`di-framework-kube`. This package owns the operator, Tenant/User CRDs, controller,
admission policies, tenant namespace declarations, and HTTP entrypoint. Application
WorkloadDeployments remain owned by application deployment tooling.

- `@di-framework/platform/local` provisions the isolated Docker/k0s cluster,
  registry, and platform used by generated CLI projects.
- `@di-framework/platform/existing` reads Pulumi configuration and installs the
  platform on a caller-owned cluster. `di-framework-kube` uses this entrypoint.
- `createPlatform(args)` installs the shared Kubernetes resources with a supplied
  Kubernetes provider. It does not create a cluster or select a Pulumi backend.

Generated projects pin the installed package version. Upgrades are explicit.
The CLI and kube must use the same project/backend/stack when operating the same
installation; sharing source code does not permit two stacks to own its resources.
The kube entrypoint claims cluster ownership before provisioning and refuses
unmanaged legacy installations. Other consumers must enforce equivalent ownership.

## Existing-cluster configuration

`kubeconfig` is required (a local file path); `context`, `namespace`, `release`,
`chart`, `chartVersion`, `httpNodePort`, `timeoutSeconds`, `insecureRegistry`,
`storageRoot`, `networkPolicyEngine`, and administrator `values` are optional. `tenants`, `users`,
`tenantHostImage`, and `tenantHostImagePullPolicy` use the same declarations as the
local entrypoint. NodePort zero selects ClusterIP. Registry installation is off
for existing clusters. Shared hosts are disabled regardless of values overrides. Set `networkPolicyEngine`
to `kube-router` to install the pinned v2.10.0 policy-only controller on clusters
without policy enforcement; `existing` leaves policy enforcement to the caller.
Managed Kubesolo enables it by default. This mode preserves the existing CNI and
service proxy ([upstream guide](https://www.kube-router.io/docs/user-guide/)).

Kubeconfig contents are a secret Pulumi input. The controller's compiled JavaScript
is loaded from this package into a ConfigMap; there is no copied TypeScript
implementation in generated projects, runtime transpilation, or custom image build.

Tenant storage currently uses local host paths. The caller must select a persistent
storage root and a cluster that enforces NetworkPolicy and the generated admission
policies. Default roots are `/var/lib/k0s` for local and `/var/lib/kubesolo` for the
existing-cluster entrypoint. Retained tenant namespaces/data survive resource
cleanup, but destroying the local cluster removes its volumes.

## Development

```sh
bun run build
bun test
npm pack
```

Build before running Pulumi mock tests, which exercise the compiled artifact.
For local cross-repository verification, pass an absolute `file:` tarball to
`di-framework-kube up --platform-package`. Publish this package before releasing
consumers that pin its version.

Existing CLI projects retain their copied implementation until explicitly updated.
To migrate, preserve the project name, backend, stack, and configuration; replace
`index.ts` with the generated package import and add the exact package dependency.
Run `pulumi preview` and verify existing resources retain their identities before
applying. The local entrypoint preserves prior logical resource names. Old copied
`tenancy.ts` and `tenancy/` files are no longer imported and can be removed after
reviewing any local customization.
