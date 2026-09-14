import { Container } from '@di-framework/core/decorators';
import { Config, OutgoingHttp, Secrets, WasmCloudBinding } from '@di-framework/wasmcloud';

@WasmCloudBinding('kube', { config: { allowedHosts: 'kubernetes.default.svc,kubernetes.default.svc.cluster.local' } })
@Container()
export class Kube extends OutgoingHttp {}

@WasmCloudBinding('platform')
@Container()
export class PlatformConfig extends Config {}

@WasmCloudBinding('tokens')
@Container()
export class TokenSecrets extends Secrets {}
