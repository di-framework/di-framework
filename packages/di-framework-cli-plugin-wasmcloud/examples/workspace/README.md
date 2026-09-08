# Demonstration workspace

Layout is arbitrary. There is no `apps/` directory and the deploy manifest has
no application list.

```text
di-framework.deploy.toml
deploy/platform/          managed Pulumi platform (k0s-adjacent cluster, registry, operator)
services/greeter/         a DI Framework project
services/settings/        unlabeled wasi:config binding (works on wasmtime -S config)
services/orders/          postgres + two named key-value bindings (imported async
                          funcs need DI_FRAMEWORK_COMPONENTIZE_QJS → wasmtime 48+ qjs)
nested/deep/echo/         another project, nested wherever it fits
```

## Managed platform

```bash
di-framework wasmcloud platform init
di-framework wasmcloud platform deploy local --yes
di-framework wasmcloud deploy greeter
# Then request http://127.0.0.1:28180 with `Host: greeter`.
di-framework wasmcloud destroy greeter
di-framework wasmcloud platform destroy local --yes
```

## Existing cluster (kubeconfig + registry only)

```bash
export KUBECONFIG="$HOME/.kube/config"
di-framework wasmcloud deploy greeter --target development
di-framework wasmcloud deploy echo --target development
```

Run the CLI directly. Do not wrap these commands in `package.json` scripts.
