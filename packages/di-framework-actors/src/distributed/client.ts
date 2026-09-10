/**
 * Remote actor client and proxy reference generator.
 */

import type { ActorRef, Constructor } from '../types';
import {
  ActorAuthorizationError,
  ActorBackpressureError,
  ActorDeadlineExceededError,
  ActorNotOwnerError,
  ActorOwnershipConflictError,
  StaleOwnerWriteError,
} from './errors';
import type { ActorRpcRequest, ActorRpcResponse, ActorTransport, RemoteRefOptions } from './types';

export interface RemoteActorClientOptions extends RemoteRefOptions {
  transport: ActorTransport;
}

function reconstructError(errorObj: any, defaultType: string): Error {
  if (!errorObj) return new Error('Unknown remote actor error');
  const name = errorObj.name ?? 'Error';
  const message = errorObj.message ?? '';

  if (name === 'StaleOwnerWriteError' || errorObj.staleOwner) {
    return new StaleOwnerWriteError(
      defaultType,
      errorObj.ownerGeneration ?? 0,
      errorObj.storageGeneration ?? 0,
    );
  }
  if (name === 'ActorAuthorizationError') {
    return new ActorAuthorizationError(defaultType, '', message);
  }
  if (name === 'ActorDeadlineExceededError') {
    return new ActorDeadlineExceededError(defaultType, 0);
  }
  if (name === 'ActorBackpressureError') {
    return new ActorBackpressureError(defaultType, 0, 0);
  }
  if (name === 'ActorOwnershipConflictError') {
    return new ActorOwnershipConflictError(defaultType, '', 0);
  }
  if (name === 'ActorNotOwnerError') {
    return new ActorNotOwnerError(defaultType);
  }

  const err = new Error(message);
  err.name = name;
  if (errorObj.stack) {
    err.stack = errorObj.stack;
  }
  return err;
}

export class RemoteActorClient {
  readonly transport: ActorTransport;
  readonly defaultOptions: RemoteRefOptions;

  constructor(options: RemoteActorClientOptions) {
    this.transport = options.transport;
    this.defaultOptions = {
      callerId: options.callerId,
      namespace: options.namespace,
      timeoutMs: options.timeoutMs ?? 30000,
      maxRetries: options.maxRetries ?? 3,
      retryDelayMs: options.retryDelayMs ?? 50,
    };
  }

  /**
   * Invokes a remote actor method over the configured transport.
   * Performs client-side deduplication, requestId assignment, deadline calculation,
   * and automatic retry with exponential backoff on transport errors.
   */
  async invokeRemote(
    actorType: string,
    actorKey: string,
    method: string,
    args: any[],
    options?: RemoteRefOptions,
  ): Promise<any> {
    const mergedOptions: RemoteRefOptions = {
      ...this.defaultOptions,
      ...options,
    };

    const requestId = crypto.randomUUID();
    const timeoutMs = mergedOptions.timeoutMs ?? 30000;
    const deadline = Date.now() + timeoutMs;
    const maxRetries = mergedOptions.maxRetries ?? 3;
    const baseDelay = mergedOptions.retryDelayMs ?? 50;

    const request: ActorRpcRequest = {
      requestId,
      callerId: mergedOptions.callerId,
      namespace: mergedOptions.namespace,
      actorType,
      actorKey,
      method,
      args,
      deadline,
    };

    let attempt = 0;
    let lastError: any;

    while (attempt <= maxRetries) {
      attempt++;
      const remaining = deadline - Date.now();
      if (remaining <= 0)
        throw new ActorDeadlineExceededError(`${actorType}:${actorKey}`, deadline, requestId);
      let receivedResponse = false;
      try {
        let timer: ReturnType<typeof setTimeout> | undefined;
        let response: ActorRpcResponse;
        try {
          response = await Promise.race([
            this.transport.send(request),
            new Promise<ActorRpcResponse>((_, reject) => {
              timer = setTimeout(
                () =>
                  reject(
                    new ActorDeadlineExceededError(`${actorType}:${actorKey}`, deadline, requestId),
                  ),
                remaining,
              );
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
        receivedResponse = true;

        if (response.success) {
          return response.result;
        }

        // Server returned an application/protocol failure response
        const err = reconstructError(response.error, `${actorType}:${actorKey}`);
        throw err;
      } catch (err: any) {
        lastError = err;

        // Do not retry authorization, stale owner, or business logic errors
        const nonRetryable =
          receivedResponse ||
          err instanceof ActorDeadlineExceededError ||
          err instanceof ActorAuthorizationError ||
          err instanceof StaleOwnerWriteError ||
          err instanceof ActorBackpressureError ||
          err?.name === 'ActorAuthorizationError' ||
          err?.name === 'StaleOwnerWriteError' ||
          err?.name === 'ActorMethodNotFoundError';

        if (nonRetryable || attempt > maxRetries) {
          throw err;
        }

        // Delay with linear backoff before retransmitting request with the SAME requestId
        const delay = Math.min(baseDelay * attempt, Math.max(0, deadline - Date.now()));
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    throw lastError;
  }

  /**
   * Returns a typed actor reference proxy that forwards all method invocations
   * over the remote transport.
   */
  get<T extends object>(
    actorClass: Constructor<T>,
    actorKey: string,
    options?: RemoteRefOptions,
  ): ActorRef<T>;
  get<T = any>(actorName: string, actorKey: string, options?: RemoteRefOptions): ActorRef<T>;
  get<T extends object>(
    actorClassOrName: Constructor<T> | string,
    actorKey: string,
    options?: RemoteRefOptions,
  ): ActorRef<T> {
    const actorType =
      typeof actorClassOrName === 'string' ? actorClassOrName : actorClassOrName.name;
    const compositeId = options?.namespace
      ? `${options.namespace}:${actorType}:${actorKey}`
      : `${actorType}:${actorKey}`;

    const target = {
      actorKey,
      actorType,
      id: compositeId,
    };

    const self = this;
    const proxy = new Proxy(target, {
      get(obj, prop, receiver) {
        if (prop === 'actorKey') return actorKey;
        if (prop === 'actorType') return actorType;
        if (prop === 'id') return compositeId;
        if (prop === 'then') return undefined;
        if (typeof prop === 'symbol') {
          return Reflect.get(obj, prop, receiver);
        }

        return (...args: any[]) => {
          return self.invokeRemote(actorType, actorKey, prop, args, options);
        };
      },
    });

    return proxy as unknown as ActorRef<T>;
  }
}
