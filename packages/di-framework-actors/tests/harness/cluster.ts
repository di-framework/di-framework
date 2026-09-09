/**
 * Test cluster harness for launching and communicating with child process actor nodes.
 */
import * as path from 'node:path';
import type {
  ActorOwnershipRecord,
  ActorRpcRequest,
  ActorRpcResponse,
  ActorTransport,
} from '../../src/distributed/types.js';

export interface TestWorkerNode {
  readonly ownerId: string;
  readonly pid: number;
  ping(): Promise<string>;
  invoke(request: ActorRpcRequest): Promise<ActorRpcResponse>;
  acquire(
    actorType: string,
    actorKey: string,
    options?: { force?: boolean; leaseTtlMs?: number },
  ): Promise<{ record?: ActorOwnershipRecord; error?: any }>;
  getOwnership(actorType: string, actorKey: string): Promise<ActorOwnershipRecord | null>;
  directStaleCommit(
    actorKey: string,
    staleGeneration: number,
    key: string,
    value: any,
  ): Promise<{ success: boolean; error?: any }>;
  crash(): Promise<void>;
  kill(): void;
  asTransport(): ActorTransport;
}

export function spawnTestWorker(ownerId: string, baseDir: string): TestWorkerNode {
  const workerScript = path.resolve(__dirname, 'worker.ts');

  const proc = Bun.spawn(
    ['bun', 'run', workerScript, `--ownerId=${ownerId}`, `--baseDir=${baseDir}`],
    {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'inherit',
    },
  );

  const pendingRequests = new Map<string, (data: any) => void>();

  // Read lines from stdout
  const stream = proc.stdout;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  (async () => {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const data = JSON.parse(trimmed);
            if (data.id && pendingRequests.has(data.id)) {
              const handler = pendingRequests.get(data.id)!;
              pendingRequests.delete(data.id);
              handler(data);
            }
          } catch {}
        }
      }
    } catch {}
  })();

  function sendCommand(msg: any): Promise<any> {
    const id = crypto.randomUUID();
    msg.id = id;
    return new Promise((resolve) => {
      pendingRequests.set(id, resolve);
      const str = `${JSON.stringify(msg)}\n`;
      proc.stdin.write(new TextEncoder().encode(str));
      proc.stdin.flush();
    });
  }

  const workerNode: TestWorkerNode = {
    ownerId,
    pid: proc.pid,

    async ping(): Promise<string> {
      const resp = await sendCommand({ type: 'ping' });
      return resp.ownerId;
    },

    async invoke(request: ActorRpcRequest): Promise<ActorRpcResponse> {
      const resp = await sendCommand({ type: 'invoke', request });
      return resp.response;
    },

    async acquire(actorType, actorKey, options) {
      const resp = await sendCommand({
        type: 'acquire',
        actorType,
        actorKey,
        force: options?.force,
        leaseTtlMs: options?.leaseTtlMs,
      });
      return { record: resp.record, error: resp.error };
    },

    async getOwnership(actorType, actorKey) {
      const resp = await sendCommand({ type: 'get_ownership', actorType, actorKey });
      return resp.record ?? null;
    },

    async directStaleCommit(actorKey, staleGeneration, key, value) {
      const resp = await sendCommand({
        type: 'direct_stale_commit',
        actorKey,
        staleGeneration,
        key,
        value,
      });
      return { success: resp.success, error: resp.error };
    },

    async crash(): Promise<void> {
      try {
        proc.kill(9);
      } catch {}
      // Give OS a moment to reap process
      await new Promise((resolve) => setTimeout(resolve, 50));
    },

    kill(): void {
      try {
        proc.kill(9);
      } catch {}
    },

    asTransport(): ActorTransport {
      return {
        send: (req: ActorRpcRequest) => workerNode.invoke(req),
      };
    },
  };

  return workerNode;
}
