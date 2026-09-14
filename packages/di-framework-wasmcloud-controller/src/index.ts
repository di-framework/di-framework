import { WorkloadComponent } from '@di-framework/wasmcloud';
import { createApp } from './app';

export { createApp, CLI_CLIENT_ID, CONTROLLER_HOST, type ControllerOptions } from './app';
export { parseDeployIntent, type DeployIntent } from './intent';
export { APPLICATION_POLICY_DOCUMENT } from './policy';

const app = createApp({ useBindings: true });

export const fetch = WorkloadComponent({ workload: 'platform', route: '/' })(app.fetch);
export default fetch;
