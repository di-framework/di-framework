/**
 * Transport implementations for distributed actor RPC.
 */
import type { ActorRpcDispatcher } from './dispatcher.js';
import type { ActorRpcRequest, ActorRpcResponse, ActorTransport } from './types.js';

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
  private readonly child: any;
  private readonly pendingRequests = new Map<
    string,
    { resolve: (resp: ActorRpcResponse) => void; reject: (err: any) => void }
  >();

  constructor(child: any) {
    this.child = child;

    // Support Bun child process IPC or standard Node child_process
    const onMessage = (data: any) => {
      if (!data || typeof data !== 'object') return;
      const resp = data as ActorRpcResponse;
      if (resp.requestId && this.pendingRequests.has(resp.requestId)) {
        const pending = this.pendingRequests.get(resp.requestId);
        if (pending) {
          this.pendingRequests.delete(resp.requestId);
          pending.resolve(resp);
        }
      }
    };

    if (typeof child.on === 'function') {
      child.on('message', onMessage);
    }
  }

  handleIncomingMessage(data: any): void {
    if (!data || typeof data !== 'object') return;
    const resp = data as ActorRpcResponse;
    if (resp.requestId && this.pendingRequests.has(resp.requestId)) {
      const pending = this.pendingRequests.get(resp.requestId);
      if (pending) {
        this.pendingRequests.delete(resp.requestId);
        pending.resolve(resp);
      }
    }
  }

  async send(request: ActorRpcRequest): Promise<ActorRpcResponse> {
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(request.requestId, { resolve, reject });

      if (typeof this.child.send === 'function') {
        this.child.send(request);
      } else if (this.child.stdin && typeof this.child.stdin.write === 'function') {
        this.child.stdin.write(`${JSON.stringify(request)}\n`);
      } else {
        reject(new Error('ChildProcessIpcTransport: Child process has no send() or stdin.'));
      }
    });
  }
}
