import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const workspace = resolve(import.meta.dir, '..');
const framework = resolve(workspace, '../..');
if (!process.env.KUBECONFIG)
  throw new Error('Set KUBECONFIG to the output of di-framework-kube kubeconfig');
const kubectl = ['kubectl', '--kubeconfig', process.env.KUBECONFIG, '-n', 'wasmcloud'];
async function run(args: string[]) {
  const child = Bun.spawn(args, { cwd: workspace, stdout: 'inherit', stderr: 'inherit' });
  if ((await child.exited) !== 0) throw new Error(`${args[0]} failed`);
}
await run([...kubectl, 'apply', '-f', 'infra/stock.yaml']);
await run([...kubectl, 'rollout', 'status', 'deployment/warehouse-redis', '--timeout=120s']);
const forward = Bun.spawn(
  [...kubectl, 'port-forward', '--address=127.0.0.1', 'service/examples-registry', '25001:5000'],
  { stdout: 'pipe', stderr: 'inherit' },
);
try {
  const reader = forward.stdout.getReader();
  let log = '';
  let timeout: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    (async () => {
      while (!log.includes('Forwarding from 127.0.0.1:25001')) {
        const { done, value } = await reader.read();
        if (done) throw new Error('Registry port-forward exited before becoming ready');
        log += new TextDecoder().decode(value);
      }
    })(),
    new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error('Registry port-forward timed out')), 15000);
    }),
  ]).finally(() => clearTimeout(timeout));
  void (async () => {
    while (!(await reader.read()).done) {
      /* drain connection messages */
    }
  })();
  for (const directory of readdirSync(resolve(workspace, 'packages')).sort()) {
    const file = Bun.file(resolve(workspace, 'packages', directory, 'di-framework.config.json'));
    if (!(await file.exists())) continue;
    const { name } = await file.json();
    await run([
      process.execPath,
      resolve(framework, 'packages/di-framework-cli/main.ts'),
      'wasmcloud',
      'deploy',
      name,
      '--target',
      'kubesolo',
    ]);
    // The kube host listens on 9191; the generic framework Service defaults to 80.
    const service = Bun.spawn(
      [...kubectl, 'get', 'service', name, '--ignore-not-found', '-o', 'name'],
      { stdout: 'pipe', stderr: 'inherit' },
    );
    const serviceName = (await new Response(service.stdout).text()).trim();
    if ((await service.exited) !== 0) throw new Error('Could not inspect application Service');
    if (serviceName)
      await run([
        ...kubectl,
        'patch',
        'service',
        name,
        '--type=merge',
        '-p',
        JSON.stringify({
          spec: { ports: [{ name: 'http', port: 80, targetPort: 9191, protocol: 'TCP' }] },
        }),
      ]);
  }
} finally {
  forward.kill();
  await forward.exited;
}
