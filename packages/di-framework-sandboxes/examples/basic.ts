import { Sandbox } from '../index.ts';

await using sandbox = await Sandbox.create({
  baseUrl: process.env.SANDBOX_BASE_URL ?? 'http://127.0.0.1:8787',
  memoryMiB: 64,
  runtime:
    (process.env.SANDBOX_RUNTIME as 'shell' | 'python' | 'node' | 'go' | undefined) ?? 'shell',
  name: 'example-basic',
});

console.log('sandbox ready', sandbox.id);

const uname = await sandbox.runChecked('uname -a');
console.log(uname.stdout);

await sandbox.writeFile('/tmp/hello.sh', '#!/bin/sh\necho hello from @di-framework/sandboxes\n', {
  mode: '0755',
});

const script = await sandbox.runChecked('/tmp/hello.sh');
console.log(script.stdout);
