import type { Env } from './env';
import { handleRequest } from './handler';

/**
 * Cloudflare Worker entry — Writerside custom search + AI embeddings,
 * wired with @di-framework/core and @di-framework/repo.
 */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleRequest(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
