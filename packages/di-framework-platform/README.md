# @di-framework/platform

Shared TypeScript/Pulumi infrastructure for the wasmCloud CLI extension and
`di-framework-kube`. This package owns the operator, Tenant/User CRDs, backing-service
CRD contracts, controller, admission policies, tenant namespace declarations, and
HTTP entrypoint. Application WorkloadDeployments remain owned by application
deployment tooling.

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
(`backing-services.js`, `resources.js`, `controller.js`) is loaded from this package
into a ConfigMap; there is no copied TypeScript implementation in generated projects,
runtime transpilation, or custom image build.

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

## Backing services

Platform install ships the three backing-service CRDs (`BackingServiceClass`,
`BackingService`, `ServiceBinding`) with OpenAPI schemas and status subresources,
seeds the approved default classes, and extends the controller ClusterRole to
watch those resources. Tenant RBAC, ValidatingAdmissionPolicy, ResourceQuota
counts, and backend NetworkPolicy isolation for bindings are enforced here (#452).
Redis/NATS reconciliation (#450), binding projection (#451), retention (#453), and
CLI (#454) build on this install path; they must not invent a conflicting shape.

Schemas and helpers live in `src/tenancy/backing-services.ts` and are included in the
platform `crds` export from `src/tenancy/resources.ts`. Class seeding and controller
script packaging live in `src/tenancy/install.ts`. Admission helpers and policies live
in `src/tenancy/admission.ts`.

### Controller-managed name prefixes (stable for #450/#451)

| Prefix / name | Kind | Owner | Purpose |
| --- | --- | --- | --- |
| `di-bs-*` | ConfigMap (and optional Secret) | Controller (#450) | Per-`BackingService` host plugin config (`url`, `backend`, …) |
| `di-binding-*` | Secret / ConfigMap | Controller (#451) | Binding-projected credentials and overlays for named `hostInterfaces` |
| `di-tenant-stock` | ConfigMap | Tenant controller | Transitional shared warehouse Redis path |

Admission allowlists these names on `configFrom` / `secretFrom`. Arbitrary
user-owned ConfigMaps/Secrets cannot be used to inject endpoints or credentials
into keyvalue/messaging host interfaces. Tenant users cannot create/update/delete
objects with these names (fail-closed ValidatingAdmissionPolicy).

### Network isolation and port-forward

Backend pods labeled `platform.di-framework.dev/component=backing-service`
(stock Redis/NATS today; `di-bs-*` deployments from #450 must use the same label)
accept ingress only from the tenant hostgroup. `allowSharedHosts` remains
`false` in generated Helm values. **Port-forward caveat:** `di-runtime-developer`
still grants `pods/portforward` so developers can reach runtime pods (including
backends) from their kubeconfig — consistent with the within-tenant Secret access
model, not a claim of developer-proof network isolation.

### Installation ownership and lifecycle

- **CRDs** are installed before any class or tenant CRs. Pulumi marks CRDs
  `retainOnDelete` so destroying or upgrading the stack does not cascade-delete
  existing `BackingService` / `ServiceBinding` instances if the cluster remains.
  Full volume/data retention for services is owned by #453.
- **Default classes** `keyvalue-redis` and `messaging-nats` are platform-owned
  cluster CRs (installation label, `visibility: AllTenants`, `default: true`).
  Override with Pulumi config `backingServiceClasses`, or disable seeding with
  `seedDefaultBackingClasses: false`.
- **Controller scripts** are TypeScript sources compiled by `tsc` into
  `dist/tenancy/*.js` (`backing-services`, `resources`, `controller`). Pulumi
  loads those compiled files into the controller ConfigMap; `resources.js`
  requires `./backing-services` at runtime. There is no runtime `transpileModule`
  or PLATFORM_TS_ASSETS allowlist for these modules.
- Scheduler/control-plane NATS remains distinct from application messaging
  `BackingService` instances.

### Contract

This section defines the v1alpha1 shape for independently requestable application
backing services.

### Resources (`platform.di-framework.dev/v1alpha1`)

| Kind | Scope | Owner |
| --- | --- | --- |
| `BackingServiceClass` | Cluster | Platform administrator |
| `BackingService` | Namespaced (`di-tenant-<name>`) | Tenant developer |
| `ServiceBinding` | Namespaced (`di-tenant-<name>`) | Tenant developer |

**BackingServiceClass** selects a capability and an approved implementation:

- `spec.type`: `keyvalue` \| `messaging`
- `spec.provider`: `redis` \| `nats`
- v1 compatibility is fixed: `keyvalue`+`redis`, `messaging`+`nats` (CEL + TypeScript helpers)
- `spec.parametersSchema` / `spec.defaults`: typed sizing only (`storage`, `memory`, `cpu`);
  no images, endpoints, hostPaths, or free-form infrastructure knobs
- `spec.visibility`: `AllTenants` \| `SelectedTenants` (requires `allowedTenants`)
- `spec.default`: at most one default class per `type`; default names are
  `keyvalue-redis` and `messaging-nats`
- Immutable after create: `type`, `provider`
- Status: `Ready` condition and `observedGeneration` only

**BackingService** is the tenant's request for a provisioned capability:

- `spec.type` required; `spec.className` optional (empty → platform default for that type)
- `spec.parameters` may override class defaults for sizing fields only
- `spec.deletionPolicy`: `Retain` (default) \| `Delete` — controls data/PV retention when
  the service is deleted (#453)
- Immutable: `type`; `className` once set/resolved
- Status conditions: `Ready`, `Provisioning`, `Failed`, `Deleting`, plus
  `observedGeneration`, `classRef`, `runtimeNamespace`, and an `endpoint` summary
  (`host`, `port`, `capability`). Status **never** contains credentials, passwords,
  tokens, connection URLs with auth material, or secret names that encode secrets.

Ownership and installation labels come from the tenant namespace and controller-managed
labels (`platform.di-framework.dev/installation`, owner UID, tenant). Users cannot
spoof cross-tenant ownership by writing labels on the object.

**ServiceBinding** associates a declared application binding with a compatible service:

- `spec.serviceName`: `BackingService` in the **same** namespace (cross-tenant refs rejected)
- `spec.bindingName`: declared application binding (e.g. `stock`, `sync`) → named
  `hostInterfaces[].name`
- `spec.capability`: must match the referenced service's `type`
- `spec.workloadName` is optional documentation/diagnostics only; **authorization is
  tenant-level in v1**, not per workload
- Multiple bindings may share one `BackingService` (warehouse `receive` / `take` /
  `sync` sharing `stock`)
- Status: `Ready` \| `Failed` \| `Deleting`, `observedGeneration`, and
  `serviceRef` (`name`/`uid`/`generation`); never credentials

### Authorization (tenant boundary)

**Decision for v1: the authorization boundary is the tenant, not a user or workload.**

Rationale from the #445 model already shipping in this platform:

- Tenant developers already have Secret CRUD in `di-tenant-<name>` and port-forward
  access to runtime pods. Claiming per-user or per-workload credential isolation
  would contradict that access.
- Redis `prefix` values are naming conventions for key layout, **not** an
  authorization boundary.
- Therefore this API does **not** claim per-user or per-workload credential isolation.

Who may:

| Actor | May |
| --- | --- |
| Platform admin | Manage `BackingServiceClass`; controllers provision infrastructure |
| Tenant developer | Create/update/delete `BackingService` and `ServiceBinding` in their tenant namespace only |
| Tenant viewer | get/list status of those resources |
| Anyone | Cross-tenant references are **rejected**; namespace ownership is source of truth |

Direct Kubernetes API submissions are authorized the same as the CLI: tenant
Roles grant developers edit / viewers read on `BackingService` and
`ServiceBinding`, and ValidatingAdmissionPolicy rejects cross-tenant label
spoofing, unknown classes (fail-closed to approved defaults), cross-namespace
`serviceName` tricks, and forged hostInterface backend selection.

Protected delivery means controller-owned generated ConfigMaps/Secrets that tenants
cannot forge or mutate to bypass provisioning — **not** secrecy from tenant
developers who can already read Secrets in their namespace.

### Runtime feasibility (wasmCloud 2.8+/2.9 hostInterfaces)

Verified against the wasmCloud Host Interface Configuration Reference:

- Named `hostInterfaces` entries are **required** for independent Redis/NATS backend
  selection. Unnamed `wasi:keyvalue` and unnamed `wasmcloud:messaging` entries ignore
  backend-selection keys on stock hosts.
- Config merge order: inline `config` ← `configFrom` ← `secretFrom` (later wins).
- Keyvalue Redis (named entry): `backend=redis`, `url` required, `prefix` optional
  (layout only, not auth).
- Messaging NATS (named entry): `backend=nats`, `url` required; subscriptions /
  consumer groups remain workload-owned configuration.
- `secretFrom` delivers credentials to the host plugin. Kubernetes Secrets in the
  tenant namespace remain readable by developers.
- Scheduler/control-plane NATS (TLS, host `wasmcloudNatsUrl` / `--scheduler-nats-url`)
  is **distinct** from application messaging `BackingService` NATS. Never conflate
  them with application backends, the registry, or the operator.

**API implication:** each `ServiceBinding` resolves to a **named** hostInterface whose
name is `spec.bindingName`. Controllers generate protected config references; do not
rely on unnamed interfaces for multi-service selection (#451).

### Distinguishing application vs control-plane dependencies

| Concern | Resource |
| --- | --- |
| Application Redis / app NATS | `BackingService` (+ class/binding) |
| Scheduler NATS, OCI registry, wasmCloud operator, tenant host pool | Platform / tenant runtime provisioning (not `BackingService`) |

Today's tenant controller still provisions per-tenant Redis/NATS deployments and the
`di-tenant-stock` ConfigMap as a transitional warehouse path. Later issues replace
that with explicit `BackingService` / `ServiceBinding` objects **without silent data
loss**: migration (#456) must retain volumes when `deletionPolicy: Retain` and must
not delete hostPath/PV data when swapping the ConfigMap for binding-projected config.

### Versioning and validation

- Group/version matches Tenant/User: `platform.di-framework.dev/v1alpha1`.
- CEL `x-kubernetes-validations` cover immutable `type`/`provider`/`className`,
  type↔provider compatibility, and `SelectedTenants` requiring `allowedTenants`.
- Same-namespace service existence and capability match against the live service
  are enforced by controllers (#450/#451); admission rejects cross-namespace
  `serviceName` forms and unknown `className` values fail-closed against approved
  defaults. Unique default-per-type and forge-resistant `di-bs-` / `di-binding-`
  config names are enforced in admission (#452); TypeScript helpers encode the same
  rules for unit tests and reconciler use.
