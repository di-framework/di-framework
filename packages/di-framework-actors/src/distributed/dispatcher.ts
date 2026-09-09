/**
 * Authoritative RPC dispatcher for remote actor invocations.
 */
import { ActorRuntime } from '../runtime/runtime.js';
import {
  ActorAuthorizationError,
  ActorDeadlineExceededError,
  StaleOwnerWriteError,
} from './errors.js';
import type { ActorAuthorizationPolicy, ActorRpcRequest, ActorRpcResponse } from './types.js';

export interface ActorRpcDispatcherOptions {
  runtime: ActorRuntime;
  authorizationPolicy?: ActorAuthorizationPolicy;
}

export class ActorRpcDispatcher {
  readonly runtime: ActorRuntime;
  readonly authorizationPolicy?: ActorAuthorizationPolicy;

  constructor(options: ActorRpcDispatcherOptions | ActorRuntime) {
    if (options instanceof ActorRuntime) {
      this.runtime = options;
      this.authorizationPolicy = options.authorizationPolicy;
    } else {
      this.runtime = options.runtime;
      this.authorizationPolicy = options.authorizationPolicy ?? options.runtime.authorizationPolicy;
    }
  }

  /**
   * Dispatches an incoming remote RPC request to the local actor runtime.
   * Performs authorization, deadline checking, idempotency deduplication,
   * serialized mailbox scheduling, and storage fencing token verification.
   */
  async dispatch(request: ActorRpcRequest): Promise<ActorRpcResponse> {
    const {
      requestId,
      namespace,
      actorType,
      actorKey,
      method,
      args = [],
      callerId,
      deadline,
      expectedGeneration,
    } = request;

    if (!requestId) {
      return {
        requestId: 'unknown',
        success: false,
        error: {
          name: 'InvalidRequestError',
          message: "Request must include a unique 'requestId'.",
        },
      };
    }

    if (!actorType || !actorKey || !method) {
      return {
        requestId,
        success: false,
        error: {
          name: 'InvalidRequestError',
          message: "Request must specify 'actorType', 'actorKey', and 'method'.",
        },
      };
    }

    // 1. Deadline check before processing
    if (deadline !== undefined && Date.now() > deadline) {
      const compositeId = namespace
        ? `${namespace}:${actorType}:${actorKey}`
        : `${actorType}:${actorKey}`;
      const err = new ActorDeadlineExceededError(compositeId, deadline, requestId);
      return {
        requestId,
        success: false,
        error: {
          name: err.name,
          message: err.message,
        },
      };
    }

    // 2. Authorization boundary check
    const policy = this.authorizationPolicy ?? this.runtime.authorizationPolicy;
    if (policy) {
      try {
        const allowed = await policy.authorize(request);
        if (allowed === false) {
          throw new ActorAuthorizationError(
            actorType,
            method,
            'Authorization policy rejected invocation.',
            { callerId, namespace },
          );
        }
      } catch (authErr: any) {
        return {
          requestId,
          success: false,
          error: {
            name: authErr.name ?? 'ActorAuthorizationError',
            message: authErr.message,
          },
        };
      }
    }

    // 3. Execution via ActorRuntime with idempotency & fencing token
    try {
      const result = await this.runtime.invoke(actorType, actorKey, method, args, {
        requestId,
        callerId,
        namespace,
        deadline,
        generation: expectedGeneration,
      });

      const ownership = await this.runtime
        .getActorOwnership(actorType, actorKey, { namespace })
        .catch(() => null);

      return {
        requestId,
        success: true,
        result,
        generation: ownership?.generation,
      };
    } catch (err: any) {
      const isStale = err instanceof StaleOwnerWriteError || err?.name === 'StaleOwnerWriteError';
      return {
        requestId,
        success: false,
        error: {
          name: err.name ?? 'ActorInvocationError',
          message: err.message,
          stack: err.stack,
          staleOwner: isStale,
          ownerGeneration: isStale ? err.ownerGeneration : undefined,
          storageGeneration: isStale ? err.storageGeneration : undefined,
        },
      };
    }
  }
}
