// Keep this side-effect import first: application services can resolve bindings at module startup.
import 'virtual:di-framework-wasmcloud-guests';

import application from 'virtual:di-framework-application';
import { guests as wasmcloudGuests } from 'virtual:di-framework-wasmcloud-guests';

export function requireGuestsObject(value: unknown): asserts value is object {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError('wasmCloud guests module must export a guests object');
  }
}

requireGuestsObject(wasmcloudGuests);

export type DispatchJob = {
  id: string;
  queue: string;
  payload: string;
  attempt: number;
  createdAt: bigint | number;
};

export const dispatch = {
  async dispatch(job: DispatchJob): Promise<{ tag: 'ok'; val: undefined } | { tag: 'err'; val: string }> {
    try {
      const app = application as any;
      let parsedPayload: unknown = job.payload;
      if (typeof job.payload === 'string') {
        try {
          parsedPayload = JSON.parse(job.payload);
        } catch {
          parsedPayload = job.payload;
        }
      }

      const jobObject = {
        id: job.id,
        queue: job.queue,
        payload: parsedPayload,
        attempt: Number(job.attempt ?? 1),
        maxRetries: 3,
        createdAt: Number(job.createdAt ?? Date.now()),
        scheduledAt: Number(job.createdAt ?? Date.now()),
        status: 'active' as const,
      };

      if (typeof app?.dispatch === 'function') {
        await app.dispatch(jobObject);
      } else if (typeof app?.execute === 'function') {
        await app.execute(jobObject);
      } else if (typeof app === 'function') {
        await app(jobObject);
      } else {
        throw new Error('No dispatcher found on default application export');
      }

      return { tag: 'ok', val: undefined };
    } catch (error) {
      console.error('Unhandled DI Framework queue dispatch error', error);
      const message = error instanceof Error ? error.message : String(error);
      return { tag: 'err', val: message };
    }
  },
};
