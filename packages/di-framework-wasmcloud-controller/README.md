# `@di-framework/wasmcloud-controller`

In-cluster wasmCloud component that is the only writer of application
`WorkloadDeployment`s. The CLI talks to it over HTTP after `wasmcloud login`;
it talks to the Kubernetes API with a namespaced ServiceAccount.

Bootstrapped by `di-framework wasmcloud platform deploy`. Application
`wasmcloud deploy` / `destroy` never kubectl.
