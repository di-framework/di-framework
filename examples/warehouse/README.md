# Warehouse namespace

Take, receive, and sync are **separately deployed packages**. They do not import each other. They join the `warehouse` colocation namespace; they are not listed in a parent composition file. Each package declares the host bindings it uses in `src/bindings.ts`.

HTTP ingress is implied: `WorkloadComponent({ route: '/take' })` and `route: '/receive'` are claims. The host HTTP plugin unions those routes. There is no gateway application.

```bash
di-framework wasmcloud deploy take
di-framework wasmcloud deploy receive
di-framework wasmcloud deploy sync
```

Sync has no route. East and west are two hosts of the same names, not two apps.
