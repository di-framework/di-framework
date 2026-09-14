import {
  bearerTokenStrategy,
  createPrincipal,
  keyService,
  memoryKeyStore,
  randomToken,
  timingSafeEqualString,
  type KeyService,
  type Principal,
} from '@di-framework/auth';
import { getPrincipal, withAuthErrors, withAuthRoutes } from '@di-framework/auth/http';
import {
  createAuthorizationServer,
  handleOAuthServerRequest,
  InMemoryAuthCodeStore,
  InMemoryClientStore,
  InMemoryConsentStore,
  InMemoryOAuthTokenStore,
} from '@di-framework/auth/server';
import { policyAuthorizationManager } from '@di-framework/authz';
import { Controller, json, TypedRouter } from '@di-framework/http';
import type { OutgoingHttpGuest } from '@di-framework/wasmcloud';
import { Kube, PlatformConfig, TokenSecrets } from './bindings';
import {
  controlSecretName,
  hostStoragePath,
  isWorkloadReady,
  labelsFromWorkload,
  type PrincipalStamp,
  workloadDocuments,
} from './documents';
import { IntentError, parseDeployIntent } from './intent';
import {
  BATCH_API,
  CORE_API,
  type ClusterSettings,
  KubeError,
  kubeJson,
  namespacedPath,
  WD_API,
} from './kube';
import {
  type MembershipTable,
  mapSubject,
  parseMembers,
  resolveMembership,
} from './membership';
import { APPLICATION_POLICY_DOCUMENT, type ApplicationResource } from './policy';
import {
  decodeSession,
  encodeSession,
  readSessionCookie,
  sessionCookieHeader,
} from './session';

export const CLI_CLIENT_ID = 'di-framework-cli';
export const CONTROLLER_HOST = 'deploy';

export type ControllerOptions = {
  issuer?: string;
  namespace?: string;
  kubeApi?: string;
  kubeToken?: string;
  members?: MembershipTable;
  bootstrapUser?: string;
  bootstrapPassword?: string;
  sessionSecret?: string;
  kube?: OutgoingHttpGuest;
  now?: () => number;
  keyService?: KeyService;
  useBindings?: boolean;
};

type Resolved = {
  issuer: string;
  namespace: string;
  kubeApi: string;
  kubeToken: string;
  members: MembershipTable;
  bootstrapUser: string;
  bootstrapPassword: string;
  sessionSecret: string;
};

const WD_COLLECTION = 'workloaddeployments';

function kindApi(kind: string): { api: string; resource: string } {
  if (kind === 'Service') return { api: CORE_API, resource: 'services' };
  if (kind === 'Secret') return { api: CORE_API, resource: 'secrets' };
  if (kind === 'CronJob') return { api: BATCH_API, resource: 'cronjobs' };
  return { api: WD_API, resource: WD_COLLECTION };
}

async function tryConfig(key: string): Promise<string | undefined> {
  try {
    const value = await new PlatformConfig().get(key);
    return typeof value === 'string' && value !== '' ? value : undefined;
  } catch {
    return undefined;
  }
}

async function trySecret(key: string): Promise<string | undefined> {
  try {
    const store = new TokenSecrets();
    const handle = await store.get(key);
    const revealed = await store.reveal(handle);
    if (typeof revealed === 'string') return revealed;
    if (revealed && typeof revealed === 'object' && 'value' in revealed) {
      const value = (revealed as { value: unknown }).value;
      return typeof value === 'string' ? value : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function createApp(options: ControllerOptions = {}): { fetch: (request: Request) => Promise<Response> } {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const keys = options.keyService ?? keyService({ store: memoryKeyStore({ silent: true }), now });
  const kube = new Kube(options.kube);
  const clients = new InMemoryClientStore([
    {
      clientId: CLI_CLIENT_ID,
      clientName: 'DI Framework CLI',
      redirectUris: [],
      allowedGrantTypes: ['authorization_code', 'refresh_token'],
      allowedScopes: ['openid', 'profile', 'offline_access'],
      isPublic: true,
      allowLoopbackRedirects: true,
    },
  ]);
  const authCodes = new InMemoryAuthCodeStore();
  const consents = new InMemoryConsentStore();
  const tokens = new InMemoryOAuthTokenStore();

  const resolved: Resolved = {
    issuer: options.issuer ?? 'http://deploy.local',
    namespace: options.namespace ?? 'wasmcloud',
    kubeApi: options.kubeApi ?? 'https://kubernetes.default.svc',
    kubeToken: options.kubeToken ?? '',
    members:
      options.members ?? {
        [options.bootstrapUser ?? 'admin']: { org: 'local', team: 'platform', roles: ['org-admin'] },
      },
    bootstrapUser: options.bootstrapUser ?? 'admin',
    bootstrapPassword: options.bootstrapPassword ?? 'local-admin',
    sessionSecret: options.sessionSecret ?? 'local-session',
  };

  let hydrated = !options.useBindings;
  async function hydrate(): Promise<Resolved> {
    if (hydrated) return resolved;
    hydrated = true;
    resolved.issuer = (await tryConfig('issuer')) ?? resolved.issuer;
    resolved.namespace = (await tryConfig('namespace')) ?? resolved.namespace;
    resolved.kubeApi = (await tryConfig('kubeApi')) ?? resolved.kubeApi;
    resolved.kubeToken = (await trySecret('kubeToken')) ?? resolved.kubeToken;
    const rawMembers = await tryConfig('members');
    if (rawMembers !== undefined) resolved.members = parseMembers(rawMembers);
    if (Object.keys(resolved.members).length === 0) {
      resolved.members = {
        [resolved.bootstrapUser]: { org: 'local', team: 'platform', roles: ['org-admin'] },
      };
    }
    resolved.bootstrapUser = (await tryConfig('bootstrapUser')) ?? resolved.bootstrapUser;
    resolved.bootstrapPassword = (await trySecret('bootstrapPassword')) ?? resolved.bootstrapPassword;
    resolved.sessionSecret = (await trySecret('sessionSecret')) ?? resolved.sessionSecret;
    return resolved;
  }

  const server = createAuthorizationServer({
    issuer: resolved.issuer,
    keyService: keys,
    clientStore: clients,
    authCodeStore: authCodes,
    consentStore: consents,
    tokenStore: tokens,
    now,
  });

  const manager = policyAuthorizationManager({
    policies: APPLICATION_POLICY_DOCUMENT,
    providers: {
      application: {
        load: async (id, context) => loadResource(id, context.action, context.principal as Principal),
      },
    },
    mapSubject: (principal) => mapSubject(principal, resolved.members),
  });

  function cluster(): ClusterSettings {
    return {
      namespace: resolved.namespace,
      kubeApi: resolved.kubeApi,
      kubeToken: resolved.kubeToken,
    };
  }

  async function getWorkload(name: string) {
    return kubeJson<{
      metadata?: { labels?: Record<string, string> };
      spec?: { replicas?: number; template?: { spec?: { volumes?: Array<{ hostPath?: { path?: string } }> } } };
      status?: {
        readyReplicas?: number;
        replicas?: { ready?: number };
        conditions?: Array<{ type?: string; status?: string }>;
      };
    }>(kube, cluster(), {
      method: 'GET',
      path: namespacedPath(WD_API, resolved.namespace, WD_COLLECTION, name),
    });
  }

  async function loadResource(
    name: string,
    action: string,
    principal: Principal,
  ): Promise<ApplicationResource | null> {
    const existing = await getWorkload(name);
    if (existing.status === 200) {
      const stamp = labelsFromWorkload(existing.value?.metadata);
      return stamp ?? null;
    }
    if (action === 'create' || action === 'read') {
      const membership = resolveMembership(principal, resolved.members);
      if (membership === undefined) return null;
      return { org: membership.org, team: membership.team };
    }
    return null;
  }

  async function authorizeAction(
    request: Request,
    name: string,
    action: 'create' | 'update' | 'delete' | 'read',
  ): Promise<Response | Principal> {
    const principal = getPrincipal(request);
    if (!principal) {
      return Response.json({ error: 'unauthorized' }, { status: 401 });
    }
    if (resolveMembership(principal, resolved.members) === undefined) {
      return Response.json({ error: 'forbidden', reason: 'no-org' }, { status: 403 });
    }
    const decision = await manager.authorize(principal, {
      transport: 'http',
      request,
      metadata: { resource: 'application', action, id: name, collection: false },
    });
    const allowed = typeof decision === 'boolean' ? decision : decision.allowed;
    if (!allowed) {
      return Response.json({ error: 'forbidden', reason: 'denied' }, { status: 403 });
    }
    return principal;
  }

  async function assertStorageOwnership(application: string, witName: string): Promise<Response | undefined> {
    const listed = await kubeJson<{
      items?: Array<{
        metadata?: { name?: string };
        spec?: { template?: { spec?: { volumes?: Array<{ hostPath?: { path?: string } }> } } };
      }>;
    }>(kube, cluster(), {
      method: 'GET',
      path: namespacedPath(WD_API, resolved.namespace, WD_COLLECTION),
    });
    if (listed.status >= 300 || listed.value === undefined) return undefined;
    const path = hostStoragePath(application);
    for (const item of listed.value.items ?? []) {
      if (item.metadata?.name === witName) continue;
      for (const volume of item.spec?.template?.spec?.volumes ?? []) {
        if (volume.hostPath?.path === path) {
          return Response.json(
            {
              error: 'storage-conflict',
              owner: item.metadata?.name ?? 'unknown',
              path,
            },
            { status: 409 },
          );
        }
      }
    }
    return undefined;
  }

  async function applyIntent(intent: ReturnType<typeof parseDeployIntent>, stamp: PrincipalStamp) {
    const secret = await kubeJson<{ data?: Record<string, string> }>(kube, cluster(), {
      method: 'GET',
      path: namespacedPath(CORE_API, resolved.namespace, 'secrets', controlSecretName(intent.witName)),
    });
    const controlToken = secret.status === 200 ? undefined : randomToken(32);
    const documents = workloadDocuments(intent, { namespace: resolved.namespace }, stamp, controlToken);
    for (const document of documents) {
      const { api, resource } = kindApi(document.kind);
      const itemPath = namespacedPath(api, resolved.namespace, resource, document.metadata.name);
      const existing = await kubeJson<{ metadata?: { resourceVersion?: string } }>(kube, cluster(), {
        method: 'GET',
        path: itemPath,
      });
      if (document.kind === 'Secret' && existing.status === 200) continue;
      if (existing.status === 404) {
        const created = await kubeJson(kube, cluster(), {
          method: 'POST',
          path: namespacedPath(api, resolved.namespace, resource),
          body: document,
        });
        if (created.status >= 300) {
          throw new KubeError(`creating ${document.kind} ${document.metadata.name} failed`, created.status);
        }
        continue;
      }
      if (existing.status >= 300) {
        throw new KubeError(`reading ${document.kind} ${document.metadata.name} failed`, existing.status);
      }
      const updated = await kubeJson(kube, cluster(), {
        method: 'PUT',
        path: itemPath,
        body: {
          ...document,
          metadata: {
            ...document.metadata,
            resourceVersion: existing.value?.metadata?.resourceVersion,
          },
        },
      });
      if (updated.status >= 300) {
        throw new KubeError(`updating ${document.kind} ${document.metadata.name} failed`, updated.status);
      }
    }
  }

  async function upsert(request: Request, name: string): Promise<Response> {
    let intent: ReturnType<typeof parseDeployIntent>;
    try {
      intent = parseDeployIntent(await request.json());
    } catch (error) {
      const message = error instanceof IntentError ? error.message : 'invalid intent';
      return Response.json({ error: message }, { status: 400 });
    }
    if (intent.application !== name && intent.witName !== name) {
      return Response.json({ error: 'application name mismatch' }, { status: 400 });
    }
    const existing = await getWorkload(intent.witName);
    const action = existing.status === 200 ? 'update' : 'create';
    const principalOrResponse = await authorizeAction(request, intent.witName, action);
    if (principalOrResponse instanceof Response) return principalOrResponse;
    const membership = resolveMembership(principalOrResponse, resolved.members);
    if (membership === undefined) {
      return Response.json({ error: 'forbidden', reason: 'no-org' }, { status: 403 });
    }
    if (action === 'create' && membership.team === undefined && !membership.roles.includes('org-admin')) {
      return Response.json({ error: 'forbidden', reason: 'no-team' }, { status: 403 });
    }
    if (intent.persistentStorage || intent.hasActors || intent.queueHandlers.length > 0) {
      const conflict = await assertStorageOwnership(intent.application, intent.witName);
      if (conflict) return conflict;
    }
    const stamp: PrincipalStamp =
      action === 'create'
        ? { org: membership.org, team: membership.team, owner: principalOrResponse.sub }
        : (labelsFromWorkload(existing.value?.metadata) ?? {
            org: membership.org,
            team: membership.team,
            owner: principalOrResponse.sub,
          });
    await applyIntent(intent, stamp);
    const after = await getWorkload(intent.witName);
    return json({
      application: intent.application,
      name: intent.witName,
      namespace: resolved.namespace,
      ready: after.value !== undefined && isWorkloadReady(after.value),
      org: stamp.org,
      team: stamp.team,
      owner: stamp.owner,
    });
  }

  async function read(request: Request, name: string): Promise<Response> {
    const principalOrResponse = await authorizeAction(request, name, 'read');
    if (principalOrResponse instanceof Response) return principalOrResponse;
    const existing = await getWorkload(name);
    if (existing.status === 404) return Response.json({ error: 'not-found' }, { status: 404 });
    const stamp = labelsFromWorkload(existing.value?.metadata);
    return json({
      name,
      namespace: resolved.namespace,
      ready: existing.value !== undefined && isWorkloadReady(existing.value),
      org: stamp?.org,
      team: stamp?.team,
      owner: stamp?.owner,
    });
  }

  async function remove(request: Request, name: string): Promise<Response> {
    const principalOrResponse = await authorizeAction(request, name, 'delete');
    if (principalOrResponse instanceof Response) return principalOrResponse;
    const resources: Array<{ api: string; resource: string; item: string }> = [
      { api: WD_API, resource: WD_COLLECTION, item: name },
      { api: CORE_API, resource: 'services', item: name },
      { api: CORE_API, resource: 'secrets', item: controlSecretName(name) },
    ];
    for (const entry of resources) {
      await kubeJson(kube, cluster(), {
        method: 'DELETE',
        path: namespacedPath(entry.api, resolved.namespace, entry.resource, entry.item),
      });
    }
    const cron = await kubeJson<{ items?: Array<{ metadata?: { name?: string } }> }>(kube, cluster(), {
      method: 'GET',
      path: `${namespacedPath(BATCH_API, resolved.namespace, 'cronjobs')}?labelSelector=${encodeURIComponent(`app.kubernetes.io/name=${name}`)}`,
    });
    for (const item of cron.value?.items ?? []) {
      if (item.metadata?.name === undefined) continue;
      await kubeJson(kube, cluster(), {
        method: 'DELETE',
        path: namespacedPath(BATCH_API, resolved.namespace, 'cronjobs', item.metadata.name),
      });
    }
    return json({ name, namespace: resolved.namespace, deleted: true });
  }

  const router = TypedRouter({ catch: withAuthErrors() });
  const strategy = bearerTokenStrategy({
    algorithms: ['ES256', 'RS256'],
    key: (header) => keys.verificationKey(header),
    issuer: resolved.issuer,
    audience: CLI_CLIENT_ID,
    toPrincipal: (claims) =>
      createPrincipal({
        sub: String(claims.sub ?? ''),
        method: 'bearer',
        issuer: typeof claims.iss === 'string' ? claims.iss : resolved.issuer,
        claims,
        ...(typeof claims.scope === 'string'
          ? { scope: claims.scope.split(' ').filter(Boolean) }
          : {}),
      }),
  });
  const secure = withAuthRoutes(router, { strategy });

  @Controller()
  class Applications {
    static create = secure.post('/applications/:name', (request) =>
      upsert(request as unknown as Request, (request as unknown as { params: { name: string } }).params.name),
    );
    static update = secure.put('/applications/:name', (request) =>
      upsert(request as unknown as Request, (request as unknown as { params: { name: string } }).params.name),
    );
    static read = secure.get('/applications/:name', (request) =>
      read(request as unknown as Request, (request as unknown as { params: { name: string } }).params.name),
    );
    static remove = secure.delete('/applications/:name', (request) =>
      remove(request as unknown as Request, (request as unknown as { params: { name: string } }).params.name),
    );
  }
  void Applications;

  async function subjectResolver(request: Request): Promise<string | undefined> {
    const cookie = readSessionCookie(request);
    if (cookie === undefined) return undefined;
    const session = await decodeSession(cookie, resolved.sessionSecret, now());
    return session?.sub;
  }

  async function handleLogin(request: Request): Promise<Response> {
    const contentType = request.headers.get('content-type') ?? '';
    let username = '';
    let password = '';
    let returnTo = '';
    if (contentType.includes('application/json')) {
      const body = (await request.json()) as Record<string, unknown>;
      username = typeof body.username === 'string' ? body.username : '';
      password = typeof body.password === 'string' ? body.password : '';
      returnTo = typeof body.return_to === 'string' ? body.return_to : '';
    } else {
      const params = new URLSearchParams(await request.text());
      username = params.get('username') ?? '';
      password = params.get('password') ?? '';
      returnTo = params.get('return_to') ?? '';
    }
    const userOk = await timingSafeEqualString(username, resolved.bootstrapUser);
    const passOk = await timingSafeEqualString(password, resolved.bootstrapPassword);
    if (!userOk || !passOk) {
      return new Response(loginPage(returnTo, 'Invalid username or password'), {
        status: 401,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }
    await consents.saveConsent({
      clientId: CLI_CLIENT_ID,
      subjectId: username,
      scopes: ['openid', 'profile', 'offline_access'],
      grantedAt: now(),
    });
    const token = await encodeSession({ sub: username, exp: now() + 600 }, resolved.sessionSecret);
    const secureCookie = resolved.issuer.startsWith('https:');
    const redirectTo = safeReturnTo(returnTo, request);
    return new Response(null, {
      status: 302,
      headers: {
        location: redirectTo,
        'set-cookie': sessionCookieHeader(token, secureCookie),
      },
    });
  }

  async function fetch(request: Request): Promise<Response> {
    await hydrate();
    const url = new URL(request.url);
    try {
      if (request.method === 'GET' && url.pathname === '/health') {
        return json({ ok: true, namespace: resolved.namespace });
      }
      if (request.method === 'GET' && url.pathname === '/login') {
        return new Response(loginPage(url.searchParams.get('return_to') ?? ''), {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }
      if (request.method === 'POST' && url.pathname === '/login') {
        return handleLogin(request);
      }
      if (
        (request.method === 'GET' || request.method === 'POST') &&
        url.pathname === '/oauth/authorize'
      ) {
        const subject = await subjectResolver(request);
        if (subject === undefined && wantsHtml(request)) {
          const returnTo = `${url.pathname}${url.search}`;
          return new Response(null, {
            status: 302,
            headers: { location: `/login?return_to=${encodeURIComponent(returnTo)}` },
          });
        }
      }
      const oauth = await handleOAuthServerRequest(request, {
        server,
        subjectResolver,
        userinfoClaimsResolver: async (subject) => {
          const membership = resolved.members[subject];
          return {
            ...(membership?.org !== undefined ? { org: membership.org } : {}),
            ...(membership?.team !== undefined ? { team: membership.team } : {}),
            ...(membership?.roles !== undefined ? { roles: membership.roles } : {}),
          };
        },
      });
      if (oauth !== null) return oauth;
      return await router.fetch(request);
    } catch (error) {
      if (error instanceof KubeError) {
        return Response.json({ error: error.message }, { status: error.status });
      }
      if (error instanceof IntentError) {
        return Response.json({ error: error.message }, { status: 400 });
      }
      throw error;
    }
  }

  return { fetch };
}

function wantsHtml(request: Request): boolean {
  const accept = request.headers.get('accept') ?? '';
  return accept.includes('text/html') || !accept.includes('application/json');
}

function safeReturnTo(value: string, request: Request): string {
  if (value.startsWith('/oauth/authorize')) return value;
  if (value.startsWith('/')) return '/';
  try {
    const url = new URL(value);
    if (url.origin === new URL(request.url).origin && url.pathname.startsWith('/oauth/authorize')) {
      return `${url.pathname}${url.search}`;
    }
  } catch {
    return '/';
  }
  return '/';
}

function loginPage(returnTo: string, error?: string): string {
  const message = error === undefined ? '' : `<p>${escapeHtml(error)}</p>`;
  return `<!doctype html>
<meta charset="utf-8">
<title>wasmCloud login</title>
<body>
<h1>Sign in</h1>
${message}
<form method="post" action="/login">
<input type="hidden" name="return_to" value="${escapeHtml(returnTo)}">
<label>Username <input name="username" autocomplete="username"></label>
<label>Password <input type="password" name="password" autocomplete="current-password"></label>
<button type="submit">Sign in</button>
</form>
</body>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
