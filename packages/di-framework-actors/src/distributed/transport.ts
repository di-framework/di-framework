/**
 * Transport implementations for distributed actor RPC.
 */
import type { ActorRpcDispatcher } from './dispatcher';
import type { ActorRpcRequest, ActorRpcResponse, ActorTransport } from './types';

/**
 * In-memory transport connecting a client to a local or simulated remote ActorRpcDispatcher.
 * Provides fault-injection capabilities (dropped responses, network delays, failures).
 */
export class MemoryActorTransport implements ActorTransport {
  private dispatcher?: ActorRpcDispatcher;
  private dropNext = false;
  private delayNextMs = 0;
  private nextError?: Error;
  private dropRate = 0;
  private _transmittedCount = 0;

  constructor(dispatcher?: ActorRpcDispatcher) {
    this.dispatcher = dispatcher;
  }

  setDispatcher(dispatcher: ActorRpcDispatcher): void {
    this.dispatcher = dispatcher;
  }

  /**
   * Drops the response of the very next request after the server finishes execution.
   * Simulates lost response in flight to test idempotency and deduplication.
   */
  dropNextResponse(): void {
    this.dropNext = true;
  }

  /**
   * Delays the next request by the specified milliseconds.
   */
  delayNextRequest(ms: number): void {
    this.delayNextMs = ms;
  }

  /**
   * Sets a random drop rate between 0.0 and 1.0 for simulated network unreliability.
   */
  setDropRate(rate: number): void {
    this.dropRate = Math.max(0, Math.min(1, rate));
  }

  /**
   * Causes the next request send() to reject immediately with the specified error.
   */
  simulateFailureNext(err: Error): void {
    this.nextError = err;
  }

  get transmittedCount(): number {
    return this._transmittedCount;
  }

  async send(request: ActorRpcRequest): Promise<ActorRpcResponse> {
    this._transmittedCount++;

    if (this.nextError) {
      const err = this.nextError;
      this.nextError = undefined;
      throw err;
    }

    if (this.delayNextMs > 0) {
      const delay = this.delayNextMs;
      this.delayNextMs = 0;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    if (!this.dispatcher) {
      throw new Error('MemoryActorTransport: No dispatcher configured to handle request.');
    }

    const response = await this.dispatcher.dispatch(request);

    if (this.dropNext || (this.dropRate > 0 && Math.random() < this.dropRate)) {
      this.dropNext = false;
      throw new Error(
        `[SimulatedNetworkFailure] Network connection lost: response for request '${request.requestId}' was dropped in flight.`,
      );
    }

    return response;
  }
}

/**
 * Child process IPC transport for multi-process test harness.
 */
export class ChildProcessIpcTransport implements ActorTransport {
  private readonly pendingRequests = new Map<
    string,
    {
      promise: Promise<ActorRpcResponse>;
      resolve: (response: ActorRpcResponse) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private disconnected = false;

  constructor(private readonly child: any) {
    if (typeof child.on === 'function') {
      child.on('message', (data: unknown) => this.handleIncomingMessage(data));
      const disconnect = () => {
        this.disconnected = true;
        for (const pending of this.pendingRequests.values()) {
          clearTimeout(pending.timer);
          pending.reject(new Error('ChildProcessIpcTransport: Child process disconnected.'));
        }
        this.pendingRequests.clear();
      };
      child.on('exit', disconnect);
      child.on('close', disconnect);
      child.on('error', disconnect);
      child.on('disconnect', disconnect);
    }
  }

  handleIncomingMessage(data: any): void {
    if (!data || typeof data !== 'object') return;
    const pending = this.pendingRequests.get(data.requestId);
    if (!pending) return;
    this.pendingRequests.delete(data.requestId);
    clearTimeout(pending.timer);
    pending.resolve(data as ActorRpcResponse);
  }

  async send(request: ActorRpcRequest): Promise<ActorRpcResponse> {
    if (this.disconnected) throw new Error('ChildProcessIpcTransport: Child process disconnected.');
    const existing = this.pendingRequests.get(request.requestId);
    if (existing) return existing.promise;
    let resolve!: (response: ActorRpcResponse) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<ActorRpcResponse>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const fail = (error: Error) => {
      const pending = this.pendingRequests.get(request.requestId);
      if (!pending) return;
      this.pendingRequests.delete(request.requestId);
      clearTimeout(pending.timer);
      pending.reject(error);
    };
    const remaining = Math.max(0, (request.deadline ?? Date.now() + 30000) - Date.now());
    const timer = setTimeout(
      () => fail(new Error('ChildProcessIpcTransport: Request timed out.')),
      remaining,
    );
    this.pendingRequests.set(request.requestId, { promise, resolve, reject, timer });
    try {
      if (typeof this.child.send === 'function') {
        this.child.send(request);
      } else if (this.child.stdin && typeof this.child.stdin.write === 'function') {
        this.child.stdin.write(`${JSON.stringify(request)}\n`);
      } else {
        throw new Error('ChildProcessIpcTransport: Child process has no send() or stdin.');
      }
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
    return promise;
  }
}
