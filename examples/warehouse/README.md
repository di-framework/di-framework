# Warehouse

Take, receive, and sync are independent packages. Each declares `"workload": "warehouse"`
in its own `di-framework.config.json`. The workload is implicit: there is no parent
project, member list, or application that imports the other packages.

```json
{
  "name": "warehouse-take",
  "entry": "src/index.ts",
  "workload": "warehouse"
}
```

Source declares behavior: `WorkloadComponent({ path: '/take' })` and
`WorkloadComponent({ path: '/receive' })` claim HTTP routes;
`WorkloadService({ path: '/sync', subscriptions: ['warehouse.stock'] })` handles broker deliveries. Both decorators require a path identifying the member
within the workload; the service path does not add HTTP ingress.
The CLI reads these declarations without executing the application.

Deployment discovers members with the same workload name and writes
`.di-framework/workloads/warehouse.json`, including member paths, HTTP routes, service subscriptions,
and entrypoint exports. Duplicate member paths fail before publishing. Each member also
gets its generated Kubernetes manifest in `packages/<member>/.di-framework/deploy/workload.yaml`.
Members remain independently deployable; Kubernetes resources carry the label
`di-framework.dev/workload=warehouse`. Sync exports the native messaging handler and
has no HTTP Service.

## Deploy to di-framework-kube

Requires Bun, Node.js, `kubectl`, `oras`, and the built framework packages. Prepare
the sibling `di-framework-kube/examples-apps` platform first: its registry must exist,
its wasmCloud host must allow local HTTP registry pulls, and its NATS service must
be running. Use that repository's deployment helper to provision those prerequisites.

From this repository's root, rebuild the changed packages:

```sh
bun run --cwd packages/di-framework-wasmcloud build
bun run --cwd packages/di-framework-cli-plugin-wasmcloud build
export KUBECONFIG="$(../di-framework-kube/bin/di-framework-kube kubeconfig)"
cd examples/warehouse
bun run deploy
```

`deploy` provisions the example Redis backend, temporarily forwards the registry on
port 25001, discovers and deploys the packages, and adjusts the HTTP Services to the
kube host's port 9191. It closes the port-forward afterward. The TypeScript smoke
probe below targets the managed tenant's data-NATS service, which does not require
the external platform's NATS client certificates.

All members use the `di-tenant-stock` ConfigMap to select the same Redis backend
and key prefix. The storage wrapper encodes strings as bytes and decodes reads.
This small example uses ephemeral Redis storage and read/modify/write stock updates;
it does not provide persistence across Redis pod replacement or concurrent inventory transactions.

For an individual deployment, expose the registry on 25001 and run:

```sh
di-framework wasmcloud deploy warehouse-take --target kubesolo
di-framework wasmcloud deploy warehouse-receive --target kubesolo
di-framework wasmcloud deploy warehouse-sync --target kubesolo
```

## Deploy and verify in a managed tenant

Create a Tenant named `warehouse` and a User with its `developer` membership using
[the generated Pulumi platform configuration](../../packages/di-framework-cli-plugin-wasmcloud/assets/platform/README.md#users-and-tenants).
The stock `ghcr.io/wasmcloud/wash:2.8.0` image is the verification target; no
`tenantHostImage` override is needed for this keyvalue binding.

Add this target to `di-framework.deploy.toml` (adjust registry addresses if your
platform uses different ports). Set `KUBECONFIG` to the developer's kubeconfig:

```toml
[targets.tenant]
kubeconfig = "${KUBECONFIG}"
namespace = "di-tenant-warehouse"
hostgroup = "tenant-warehouse"

[targets.tenant.registry]
push = "http://127.0.0.1:25000"
pull = "di-framework-registry.wasmcloud.svc.cluster.local:5000"
insecure = true
```

The controller already provisions Redis and `di-tenant-stock`. Deploy the members
directly; the external-cluster `bun run deploy` helper provisions different infrastructure:

```sh
di-framework wasmcloud deploy warehouse-receive --target tenant
di-framework wasmcloud deploy warehouse-take --target tenant
di-framework wasmcloud deploy warehouse-sync --target tenant
```

Open these port-forwards in two terminals, using the developer kubeconfig:

```sh
kubectl -n di-runtime-warehouse port-forward service/di-http 28182:80
kubectl -n di-runtime-warehouse port-forward service/di-nats 24222:4222
```

Then run `bun run smoke`. It uses a unique SKU and verifies receive 3, take 2,
insufficient stock, a real NATS sync request/reply setting stock to 9, and take 9.
The reply is sent only after the sync handler writes Redis. No mock bindings or
scheduler credentials are used. Override `WAREHOUSE_HTTP_URL` and
`WAREHOUSE_NATS_URL` if using different forwarded ports. The NATS probe expects
the plain tenant data-NATS connection through the Kubernetes tunnel.

Verified on 2026-09-14 in the generated k0s platform using developer ServiceAccount
credentials and the stock runtime image, with resolved image digest
`sha256:e42ead7db995a710a78836c25483ce3fab9162bf7742e73b262b1019b081df5b`.
All three WorkloadDeployments became Ready, all smoke assertions passed, and an
administrator confirmed the test SKU's final value of `0` directly in tenant Redis.
No custom runtime image or scheduler credentials were used by the application/probe.

## HTTP and messaging

The current wasmCloud 2.8 host routes HTTP by each member's Host header. The generated
workload manifest records the route union, but the host does not yet expose it under
one `Host: warehouse`. Sharing that hostname would load balance requests between
members, not dispatch by path. No gateway application is added.

```sh
curl -X POST -H 'Host: warehouse-receive' \
  'http://127.0.0.1:28080/receive?sku=pallet-a&qty=3'
curl -X POST -H 'Host: warehouse-take' \
  'http://127.0.0.1:28080/take?sku=pallet-a&qty=2'
```

Peer stock arrives as JSON on NATS subject `warehouse.stock`, for example
`{"sku":"pallet-a","qty":9}`. Sync sets the absolute stock count and, when a reply
subject is supplied, acknowledges after storing it. Malformed events are rejected.
This is core NATS delivery, not a durable replication protocol.
