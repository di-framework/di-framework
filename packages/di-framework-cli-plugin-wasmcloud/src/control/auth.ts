/** Cluster-private control-plane authentication for cron/queue/actor admin APIs. */

export type ControlIdentity = {
  id: string;
  token: string;
  roles: readonly string[];
};

export type ControlAuthResult =
  | { ok: true; identity: ControlIdentity }
  | { ok: false; status: number; error: string };

function configuredIdentities(): ControlIdentity[] {
  const raw = process.env.DI_CONTROL_IDENTITIES;
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Array<{ id: string; token: string; roles?: string[] }>;
      if (Array.isArray(parsed)) {
        return parsed
          .filter((entry) => entry && typeof entry.id === 'string' && typeof entry.token === 'string')
          .map((entry) => ({
            id: entry.id,
            token: entry.token,
            roles: Array.isArray(entry.roles) ? entry.roles : ['invoke'],
          }));
      }
    } catch {
      // fall through to single-token config
    }
  }
  const token = process.env.DI_CONTROL_TOKEN ?? process.env.token;
  if (typeof token === 'string' && token.length > 0) {
    return [{ id: process.env.DI_CONTROL_IDENTITY ?? 'default', token, roles: ['invoke', 'admin'] }];
  }
  return [];
}

export function authorizeControlRequest(
  request: Request,
  requiredRoles: readonly string[] = ['invoke'],
): ControlAuthResult {
  const identities = configuredIdentities();
  // Local/dev components without configured secrets stay open; production manifests
  // bind Secret-backed DI_CONTROL_TOKEN / DI_CONTROL_IDENTITIES before exposure.
  if (identities.length === 0) {
    return {
      ok: true,
      identity: { id: 'anonymous', token: '', roles: ['invoke', 'admin'] },
    };
  }

  const header = request.headers.get('authorization') ?? request.headers.get('x-di-control-token');
  if (!header) {
    return { ok: false, status: 401, error: 'Missing control credentials' };
  }
  const token = header.toLowerCase().startsWith('bearer ')
    ? header.slice('bearer '.length).trim()
    : header.trim();
  const identity = identities.find((entry) => entry.token === token);
  if (!identity) {
    return { ok: false, status: 403, error: 'Unauthorized control credentials' };
  }
  if (requiredRoles.some((role) => !identity.roles.includes(role) && !identity.roles.includes('admin'))) {
    return { ok: false, status: 403, error: 'Insufficient control privileges' };
  }
  return { ok: true, identity };
}

export function unauthorizedResponse(result: Extract<ControlAuthResult, { ok: false }>): Response {
  return new Response(JSON.stringify({ success: false, error: result.error }), {
    status: result.status,
    headers: { 'content-type': 'application/json' },
  });
}
