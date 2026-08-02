// main.ts (entry file)
// Run locally: deno run --allow-net --allow-env main.ts
// Deploy to Deno Deploy: push as-is (Sandbox works natively)

import { Sandbox } from '@deno/sandbox';
import { Bootstrap, Component, Container, Telemetry } from '@di-framework/core/decorators';
import {
  Controller,
  Endpoint,
  type Json,
  json,
  type RequestSpec,
  type ResponseSpec,
  TypedRouter,
} from '@di-framework/http';

// Router setup
type Env = {};
type ExecutionContext = {};

export const router = TypedRouter<[Env, ExecutionContext]>();
export const env: Env = {};
export const ctx: ExecutionContext = {};

// Types
type CreateSandboxResponse = { created: boolean; sandboxId: string; message: string };
type ExecuteResponse = { output: string; success: boolean };
type RunPythonResponse = ExecuteResponse; // same shape

interface CreateSandboxRequest {
  message: string;
}

interface ExecuteRequest {
  command: string; // e.g. "ls -la" or "pip install numpy && python -c 'print(123)'"
}

interface RunPythonRequest {
  code: string; // Python code snippet, e.g. "print('Hello from Python!')"
}

@Container()
class SandboxService {
  // Active sandboxes (id → Sandbox instance)
  private sandboxes = new Map<string, Sandbox>();

  @Telemetry({ logging: true })
  async createSandbox(args: { message: string }): Promise<CreateSandboxResponse> {
    const id = crypto.randomUUID();

    // Strict defaults: no network, no env leakage.
    const sandbox = await Sandbox.create({
      allowNet: [], // tighten further if needed, e.g. ["pypi.org"] for pip
      // memory: 2048,
      // timeout: "10m",  // uncomment for longer-lived sandboxes
    });

    // Keep sandbox alive until explicit DELETE /api/sandbox/:id.
    this.sandboxes.set(id, sandbox);

    return {
      created: true,
      sandboxId: id,
      message: args.message,
    };
  }

  async getSandbox(id: string): Promise<Sandbox | null> {
    return this.sandboxes.get(id) ?? null;
  }

  async destroySandbox(id: string): Promise<boolean> {
    const sandbox = this.sandboxes.get(id);
    if (!sandbox) return false;
    await sandbox.close();
    this.sandboxes.delete(id);
    return true;
  }

  async executeCommand(id: string, command: string): Promise<ExecuteResponse> {
    const sandbox = await this.getSandbox(id);
    if (!sandbox) return { output: 'Sandbox not found', success: false };

    try {
      // Run through bash -lc so user-provided command strings behave naturally.
      const child = await sandbox.spawn('bash', {
        args: ['-lc', command],
        stdout: 'piped',
        stderr: 'piped',
      });
      const result = await child.output();
      const output = `${result.stdoutText ?? ''}${result.stderrText ?? ''}`;
      return { output, success: result.status.success };
    } catch (err) {
      return { output: err instanceof Error ? err.message : String(err), success: false };
    }
  }

  async runPythonCode(id: string, code: string): Promise<RunPythonResponse> {
    const sandbox = await this.getSandbox(id);
    if (!sandbox) return { output: 'Sandbox not found', success: false };

    try {
      const child = await sandbox.spawn('python3', {
        args: ['-c', code],
        stdout: 'piped',
        stderr: 'piped',
      });
      const result = await child.output();
      const output = `${result.stdoutText ?? ''}${result.stderrText ?? ''}`;
      return { output, success: result.status.success };
    } catch (err) {
      return { output: err instanceof Error ? err.message : String(err), success: false };
    }
  }
}

@Bootstrap()
@Controller()
export class SandboxController {
  constructor(@Component(SandboxService) private service: SandboxService) {}

  // Create sandbox
  @Endpoint({ summary: 'Create a secure sandbox' })
  createSandbox = router.post<
    RequestSpec<Json<CreateSandboxRequest>>,
    ResponseSpec<CreateSandboxResponse>
  >('/api/sandbox', async (req) => {
    const body = (await req.json()) as CreateSandboxRequest;
    if (!body.message) throw new Error('Message required');

    const result = await this.service.createSandbox({ message: body.message });
    return json(result, { status: 201 });
  });

  // Execute shell command
  @Endpoint({ summary: 'Execute shell command in sandbox' })
  execute = router.post<RequestSpec<Json<ExecuteRequest>>, ResponseSpec<ExecuteResponse>>(
    '/api/sandbox/:id/execute',
    async (req) => {
      const id = req.params.id;
      const body = (await req.json()) as ExecuteRequest;

      if (!body.command) throw new Error('Command required');

      const result = await this.service.executeCommand(id, body.command);
      return json(result, { status: result.success ? 200 : 400 });
    },
  );

  // Run Python code snippet
  @Endpoint({ summary: 'Execute Python code in sandbox' })
  runPython = router.post<RequestSpec<Json<RunPythonRequest>>, ResponseSpec<RunPythonResponse>>(
    '/api/sandbox/:id/run-python',
    async (req) => {
      const id = req.params.id;
      const body = (await req.json()) as RunPythonRequest;

      if (!body.code) throw new Error('Python code required');

      const result = await this.service.runPythonCode(id, body.code);
      return json(result, { status: result.success ? 200 : 400 });
    },
  );

  // Destroy sandbox
  @Endpoint({ summary: 'Destroy a sandbox' })
  destroy = router.delete('/api/sandbox/:id', async (req) => {
    const id = req.params.id;
    const destroyed = await this.service.destroySandbox(id);
    return json({ destroyed }, { status: destroyed ? 200 : 404 });
  });
}

if (import.meta.main) {
  console.log('Server running on http://localhost:8000');
  Deno.serve({ port: 8000 }, async (request: Request) => {
    try {
      const response = await router.fetch(request, env, ctx);
      return response ?? new Response('Not Found', { status: 404 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return json({ error: message }, { status: 500 });
    }
  });
}
