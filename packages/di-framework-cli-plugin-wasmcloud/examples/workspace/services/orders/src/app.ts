import { Cache, Sessions, UserDatabase } from './bindings.ts';

export default async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  if (url.pathname === '/health') {
    return new Response(
      JSON.stringify({
        database: UserDatabase.name,
        sessions: Sessions.name,
        cache: Cache.name,
      }),
      { headers: { 'content-type': 'application/json' } },
    );
  }
  return new Response('orders\n');
};
