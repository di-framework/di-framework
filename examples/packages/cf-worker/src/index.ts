import { DurableObject } from 'cloudflare:workers';
import { useContainer } from '@di-framework/di-framework/container';
import { LoggerService } from '../../services/LoggerService';
import { handleRequest } from './router';

// Wire up a couple of tokens via factory to demonstrate string-token injection
const container = useContainer();
if (!container.has('APP_NAME')) {
  container.registerFactory('APP_NAME', () => 'DI Worker Example', {
    singleton: true,
  });
}

// Ensure core services are registered (decorators register on import, but
// importing here guarantees side-effects under bundlers)
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _ensureLogger = LoggerService;

/**
 * Welcome to Cloudflare Workers! This is your first Durable Objects application.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your Durable Object in action
 * - Run `npm run deploy` to publish your application
 *
 * Bind resources to your worker in `wrangler.jsonc`. After adding bindings, a type definition for the
 * `Env` object can be regenerated with `npm run cf-typegen`.
 *
 * Learn more at https://developers.cloudflare.com/durable-objects
 */

/** A Durable Object's behavior is defined in an exported Javascript class */
export class MyDurableObject extends DurableObject<Env> {
  /**
   * The constructor is invoked once upon creation of the Durable Object, i.e. the first call to
   * 	`DurableObjectStub::get` for a given identifier (no-op constructors can be omitted)
   *
   * @param ctx - The interface for interacting with Durable Object state
   * @param env - The interface to reference bindings declared in wrangler.jsonc
   */
  constructor(
    state: DurableObjectState,
    env: Env,
    private readonly ctx: ExecutionContext,
  ) {
    super(state, env, ctx);
  }

  /**
   * The Durable Object exposes an RPC method sayHello which will be invoked when when a Durable
   *  Object instance receives a request from a Worker via the same method invocation on the stub
   *
   * @param name - The name provided to a Durable Object instance from a Worker
   * @returns The greeting to be sent back to the Worker
   */
  async sayHello(name: string): Promise<string> {
    return `Hello, ${name}!`;
  }

  // Simple stateful counter using Durable Object storage
  async increment(delta: number = 1): Promise<number> {
    const current = (await this.ctx.storage.get<number>('count')) ?? 0;
    const next = current + (Number.isFinite(delta) ? delta : 1);
    await this.ctx.storage.put('count', next);
    return next;
  }

  async getCount(): Promise<number> {
    return (await this.ctx.storage.get<number>('count')) ?? 0;
  }

  async reset(): Promise<number> {
    await this.ctx.storage.put('count', 0);
    return 0;
  }
}

export default {
  /**
   * This is the standard fetch handler for a Cloudflare Worker
   *
   * @param request - The request submitted to the Worker from the client
   * @param env - The interface to reference bindings declared in wrangler.jsonc
   * @param ctx - The execution context of the Worker
   * @returns The response to be sent back to the client
   */
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleRequest(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
