import { AppConfig } from './bindings.ts';

export default async (request: Request): Promise<Response> => {
  const config = new AppConfig();
  const url = new URL(request.url);
  const key = url.searchParams.get('key') ?? 'greeting';
  const value = await Promise.resolve(config.get(key));
  return new Response(`${value ?? ''}\n`, {
    headers: { 'content-type': 'text/plain' },
  });
};
