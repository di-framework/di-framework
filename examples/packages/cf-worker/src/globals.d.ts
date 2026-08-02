declare module 'cloudflare:workers' {
  export class DurableObject<Env> {
    constructor(state: DurableObjectState, env: Env, ctx: ExecutionContext);
  }
}

type Env = Record<string, any>;

interface ExecutionContext {
  waitUntil(promise: Promise<any>): void;

  passThroughOnException(): void;

  storage: DurableObjectStorage;
}

interface DurableObject {
  new (state: DurableObjectState, env: Env): DurableObject<Env>;
}

type DurableObjectState = {
  id: DurableObjectId;
  storage: DurableObjectStorage;
  ctx: ExecutionContext;
};

interface DurableObjectId {
  toString(): string;

  equals(other: DurableObjectId): boolean;

  readonly name?: string;
}

interface DurableObjectStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;

  get<T = unknown>(keys: string[]): Promise<Map<string, T>>;

  put<T>(key: string, value: T): Promise<void>;

  put<T>(entries: Record<string, T>): Promise<void>;

  delete(key: string): Promise<boolean>;

  delete(keys: string[]): Promise<number>;

  list<T = unknown>(options?: {
    start?: string;
    end?: string;
    prefix?: string;
    reverse?: boolean;
    limit?: number;
  }): Promise<Map<string, T>>;

  transaction<T>(closure: (txn: DurableObjectTransaction) => Promise<T>): Promise<T>;

  deleteAll(): Promise<void>;
}

interface DurableObjectTransaction {
  get<T = unknown>(key: string): Promise<T | undefined>;

  get<T = unknown>(keys: string[]): Promise<Map<string, T>>;

  put<T>(key: string, value: T): Promise<void>;

  put<T>(entries: Record<string, T>): Promise<void>;

  delete(key: string): Promise<boolean>;

  delete(keys: string[]): Promise<number>;

  rollback(): void;
}

interface ExportedHandler<Env> {
  // new (state: DurableObjectState, env: Env): DurableObject<Env>;
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response>;
}
