// (Run this with Deno: `deno run --allow-net --allow-env sandbox-example.ts`)
// Requires: deno add @deno/sandbox (or import directly)

import { Sandbox } from '@deno/sandbox';

// 1. Create a sandbox with strict network policies + secret injection
//    (only api.openai.com is allowed; API key is never visible inside the sandbox)
await using sandbox = await Sandbox.create({
  allowNet: ['api.openai.com'], // granular egress control
  region: 'ams', // optional: Amsterdam (default is closest)
  memory: 2048, // 2 GB (default is 1.2 GB)
  secrets: {
    OPENAI_API_KEY: {
      hosts: ['api.openai.com'], // key is only substituted on outbound calls to this host
      value: Deno.env.get('OPENAI_API_KEY') ?? 'sk-...',
    },
  },
});

// 2. The sandbox boots in < 1 second and gives you a full Linux microVM

// Run a shell command (tagged template literal)
console.log('Sandbox ID:', sandbox.id);
await sandbox.sh`ls -la /`; // basic filesystem check

// Install packages (pip is available)
await sandbox.sh`pip install requests`;

// 3. Run Python code that uses the injected secret (never exposed to you or the sandbox)
const pythonCode = `
import os
import requests

api_key = os.environ.get("OPENAI_API_KEY")
print("Secret is available inside the sandbox:", bool(api_key))

response = requests.post(
    "https://api.openai.com/v1/chat/completions",
    headers={
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    },
    json={
        "model": "gpt-4o-mini",
        "messages": [{"role": "user", "content": "Say hello from Deno Sandbox!"}],
        "max_tokens": 20,
    },
)
print(response.json()["choices"][0]["message"]["content"])
`;

await sandbox.sh`python3 -c ${pythonCode}`; // execute the script safely

// 4. You can also spawn long-running processes or dev servers
// await sandbox.spawn("python3", ["-m", "http.server", "8000"]);

// 5. The sandbox is automatically torn down when the `await using` block ends
//    (or call await sandbox.destroy() manually)
console.log('✅ Sandbox destroyed. All resources cleaned up.');
