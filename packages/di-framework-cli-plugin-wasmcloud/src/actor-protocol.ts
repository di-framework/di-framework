import type { ActorRuntime } from '@di-framework/actors';
export const ACTORS_INVOCATION_PATH = '/_actors/invoke';

export function isActorInvocationRequest(request: Request): boolean {
  try {
    const url = new URL(request.url);
    return url.pathname.startsWith('/_actors/');
  } catch {
    return false;
  }
}

export async function handleActorInvocationRequest(
  request: Request,
  runtime?: ActorRuntime,
  dispatchFn?: (
    actorType: string,
    actorKey: string,
    method: string,
    args?: unknown[],
  ) => Promise<unknown>,
): Promise<Response> {
  if (!runtime && !dispatchFn) {
    return new Response(
      JSON.stringify({
        success: false,
        error: {
          name: 'ActorRuntimeError',
          message: 'No actor runtime or actors registered in this component',
        },
      }),
      { status: 404, headers: { 'content-type': 'application/json' } },
    );
  }

  try {
    let actorType: string | undefined;
    let actorKey: string | undefined;
    let method: string | undefined;
    let args: unknown[] = [];

    const url = new URL(request.url);
    const subPath = url.pathname.replace(/^\/_actors\/?/, '');
    const pathParts = subPath ? subPath.split('/').filter(Boolean) : [];

    if (request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      actorType = body.actorType ?? request.headers.get('x-actor-type') ?? pathParts[0];
      actorKey = body.actorKey ?? request.headers.get('x-actor-key') ?? pathParts[1];
      method = body.method ?? request.headers.get('x-actor-method') ?? pathParts[2];
      args = Array.isArray(body.args) ? body.args : [];
    } else {
      actorType = request.headers.get('x-actor-type') ?? pathParts[0];
      actorKey = request.headers.get('x-actor-key') ?? pathParts[1];
      method = request.headers.get('x-actor-method') ?? pathParts[2];
      const qArgs = url.searchParams.get('args');
      if (qArgs) {
        try {
          const parsed = JSON.parse(qArgs);
          args = Array.isArray(parsed) ? parsed : [parsed];
        } catch {
          args = [qArgs];
        }
      }
    }

    if (!actorType || !actorKey || !method) {
      return new Response(
        JSON.stringify({
          success: false,
          error: {
            name: 'ActorInvocationBadRequest',
            message: 'actorType, actorKey, and method are required for actor invocation',
          },
        }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      );
    }

    const invoke = dispatchFn ?? ((t, k, m, a) => runtime!.invoke(t, k, m, a ?? []));
    const result = await invoke(actorType, actorKey, method, args);

    return new Response(
      JSON.stringify({
        success: true,
        result,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  } catch (error: any) {
    const name =
      [
        'ActorNotRegisteredError',
        'ActorMethodNotFoundError',
        'ActorInvocationBadRequest',
        'ActorMigrationError',
      ].find((candidate) => candidate === error?.name) ?? 'ActorInvocationError';
    const isNotFound = name === 'ActorNotRegisteredError' || name === 'ActorMethodNotFoundError';
    const isBadRequest = name === 'ActorInvocationBadRequest';
    const status = isNotFound ? 404 : isBadRequest ? 400 : 500;
    const message = isNotFound
      ? 'Actor or method not found'
      : isBadRequest
        ? 'Invalid actor invocation'
        : 'Actor invocation failed';

    return new Response(
      JSON.stringify({
        success: false,
        error: {
          name,
          message,
        },
      }),
      { status, headers: { 'content-type': 'application/json' } },
    );
  }
}
