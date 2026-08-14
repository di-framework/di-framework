import createClient, { type Client } from 'openapi-fetch';
import { type ApiErrorBody, SandboxApiError } from './errors.ts';
import type { components, paths } from './generated/schema.d.ts';
import { sleep } from './sleep.ts';
import type { ControlClientOptions, WaitOptions } from './types.ts';

export type Instance = components['schemas']['Instance'];
export type InstanceStatus = components['schemas']['InstanceStatus'];
export type CreateInstanceRequest = components['schemas']['CreateInstanceRequest'];
export type SerialOutput = components['schemas']['SerialOutput'];
export type Health = components['schemas']['Health'];
export type { ApiErrorBody };

export class ControlClient {
  readonly raw: Client<paths>;

  constructor(options: ControlClientOptions = {}) {
    this.raw = createClient<paths>({
      baseUrl: normalizeBaseUrl(options.baseUrl ?? 'http://127.0.0.1:8787'),
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.headers ? { headers: options.headers } : {}),
    });
  }

  async health(): Promise<Health> {
    return unwrap(await this.raw.GET('/health'));
  }

  async list(): Promise<Instance[]> {
    return unwrap(await this.raw.GET('/v1/instances'));
  }

  async create(request: CreateInstanceRequest): Promise<Instance> {
    return unwrap(
      await this.raw.POST('/v1/instances', {
        body: request,
      }),
    );
  }

  async get(id: string): Promise<Instance> {
    return unwrap(
      await this.raw.GET('/v1/instances/{id}', {
        params: { path: { id } },
      }),
    );
  }

  async start(id: string): Promise<Instance> {
    return unwrap(
      await this.raw.POST('/v1/instances/{id}/start', {
        params: { path: { id } },
      }),
    );
  }

  async stop(id: string): Promise<Instance> {
    return unwrap(
      await this.raw.POST('/v1/instances/{id}/stop', {
        params: { path: { id } },
      }),
    );
  }

  async delete(id: string): Promise<void> {
    unwrapVoid(
      await this.raw.DELETE('/v1/instances/{id}', {
        params: { path: { id } },
      }),
    );
  }

  async sendSerial(id: string, data: string): Promise<void> {
    unwrapVoid(
      await this.raw.POST('/v1/instances/{id}/serial', {
        params: { path: { id } },
        body: { data },
      }),
    );
  }

  async readSerial(id: string, cursor = 0): Promise<SerialOutput> {
    return unwrap(
      await this.raw.GET('/v1/instances/{id}/serial', {
        params: {
          path: { id },
          query: { cursor },
        },
      }),
    );
  }

  async waitForStatus(
    id: string,
    wanted: InstanceStatus | InstanceStatus[],
    options: WaitOptions = {},
  ): Promise<Instance> {
    const wantedStatuses = new Set(Array.isArray(wanted) ? wanted : [wanted]);
    const timeoutMs = options.timeoutMs ?? 30_000;
    const pollIntervalMs = options.pollIntervalMs ?? 100;
    const deadline = Date.now() + timeoutMs;

    while (true) {
      options.signal?.throwIfAborted();
      const instance = await this.get(id);
      if (wantedStatuses.has(instance.status)) return instance;
      if (instance.status === 'failed') {
        throw new Error(instance.last_error ?? `instance ${id} failed`);
      }
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for ${id} to reach ${[...wantedStatuses].join(', ')}`);
      }
      await sleep(pollIntervalMs, options.signal);
    }
  }

  async *serial(
    id: string,
    options: WaitOptions & { cursor?: number } = {},
  ): AsyncGenerator<string, never, void> {
    let cursor = options.cursor ?? 0;
    const pollIntervalMs = options.pollIntervalMs ?? 50;

    while (true) {
      options.signal?.throwIfAborted();
      const output = await this.readSerial(id, cursor);
      cursor = output.cursor;
      if (output.data) yield output.data;
      await sleep(pollIntervalMs, options.signal);
    }
  }
}

type FetchResult<T> =
  | { data?: T; error?: unknown; response: Response }
  | { data: T; error?: never; response: Response };

function unwrap<T>(result: FetchResult<T>): NonNullable<T> {
  if (result.error !== undefined || !result.response.ok || result.data == null) {
    throw new SandboxApiError(
      result.response.status,
      isApiError(result.error) ? result.error : undefined,
    );
  }
  return result.data as NonNullable<T>;
}

function unwrapVoid(result: FetchResult<unknown>): void {
  if (result.error !== undefined || !result.response.ok) {
    throw new SandboxApiError(
      result.response.status,
      isApiError(result.error) ? result.error : undefined,
    );
  }
}

function isApiError(value: unknown): value is ApiErrorBody {
  return typeof value === 'object' && value !== null && 'code' in value && 'message' in value;
}

function normalizeBaseUrl(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}
