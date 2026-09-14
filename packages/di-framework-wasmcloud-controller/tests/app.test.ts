import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { keyService, memoryKeyStore, signJwt } from '@di-framework/auth';
import { generatePkce } from '@di-framework/auth/oauth';
import * as authz from '@di-framework/authz';
import { resetGuests, setGuests } from '@di-framework/wasmcloud';
import { CLI_CLIENT_ID, createApp } from '../src/app';
import { APPLICATION_LABEL, IntentError, ORG_LABEL, TEAM_LABEL } from '../src/intent';

const ISSUER = 'http://deploy.local';

type KubeRequest = { method: string; url: string; body?: string };

function fakeKube() {
  const resources = new Map<string, Record<string, unknown>>();
  return {
    resources,
    send: async (request: KubeRequest) => {
      const url = new URL(request.url);
      const path = url.pathname;
      const method = request.method.toUpperCase();
      if (method === 'GET') {
        const found = resources.get(path);
        if (found !== undefined) return { status: 200, body: JSON.stringify(found) };
        if (
          path.endsWith('/workloaddeployments') ||
          path.endsWith('/cronjobs') ||
          path.endsWith('/services') ||
          path.endsWith('/secrets')
        ) {
          const items = [...resources.entries()]
            .filter(([key]) => key.startsWith(`${path}/`))
            .map(([, value]) => value);
          return { status: 200, body: JSON.stringify({ items }) };
        }
        return { status: 404, body: JSON.stringify({ reason: 'NotFound' }) };
      }
      if (method === 'POST') {
        const document = JSON.parse(request.body ?? '{}') as {
          metadata: { name: string };
        };
        const itemPath = `${path}/${document.metadata.name}`;
        const stored = {
          ...document,
          status: { readyReplicas: 1, conditions: [{ type: 'Available', status: 'True' }] },
        };
        resources.set(itemPath, stored);
        return { status: 201, body: JSON.stringify(stored) };
      }
      if (method === 'PUT') {
        const document = JSON.parse(request.body ?? '{}') as Record<string, unknown>;
        const stored = {
          ...document,
          status: { readyReplicas: 1, conditions: [{ type: 'Available', status: 'True' }] },
        };
        resources.set(path, stored);
        return { status: 200, body: JSON.stringify(stored) };
      }
      if (method === 'DELETE') {
        resources.delete(path);
        return { status: 200, body: JSON.stringify({ status: 'Success' }) };
      }
      return { status: 405, body: '' };
    },
  };
}

const members = {
  alice: { org: 'acme', team: 'warehouse', roles: ['member'] },
  bob: { org: 'acme', team: 'checkout', roles: ['member'] },
  admin: { org: 'acme', team: 'platform', roles: ['org-admin'] },
  eve: { org: 'other', team: 'warehouse', roles: ['member'] },
};

const intent = {
  application: 'warehouse-take',
  witName: 'warehouse-take',
  image: `registry.example.com/take@sha256:${'a'.repeat(64)}`,
  deploymentDigest: 'abc',
  ingress: true,
  worker: false,
  bindings: [],
  hasActors: false,
  persistentStorage: false,
  cronJobs: [],
  queueHandlers: [],
};

afterEach(() => resetGuests());

describe('deploy controller', () => {
  let keys: ReturnType<typeof keyService>;
  let kube: ReturnType<typeof fakeKube>;
  let fetch: (request: Request) => Promise<Response>;

  beforeEach(async () => {
    keys = keyService({ store: memoryKeyStore({ silent: true }) });
    kube = fakeKube();
    const app = createApp({
      issuer: ISSUER,
      namespace: 'wasmcloud',
      kubeApi: 'https://kubernetes.default.svc',
      kubeToken: 'sa-token',
      members,
      kube: { send: (request) => kube.send(request as KubeRequest) },
      keyService: keys,
      bootstrapUser: 'admin',
      bootstrapPassword: 's3cret',
      sessionSecret: 'session-secret',
    });
    fetch = app.fetch;
    await keys.signingKey();
  });

  async function bearer(sub: string): Promise<string> {
    const { key, record } = await keys.signingKey();
    return signJwt(
      { iss: ISSUER, sub, aud: CLI_CLIENT_ID, type: 'access_token' },
      {
        algorithm: record.algorithm as 'ES256',
        key,
        kid: record.kid,
        expiresInSeconds: 3600,
      },
    );
  }

  function url(path: string): string {
    return `http://deploy.local${path}`;
  }

  it('serves unauthenticated health', async () => {
    const response = await fetch(new Request(url('/health')));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, namespace: 'wasmcloud' });
  });

  it('rejects deploy without a bearer token', async () => {
    const response = await fetch(
      new Request(url('/applications/warehouse-take'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(intent),
      }),
    );
    expect(response.status).toBe(401);
  });

  it('creates a workload stamped with org and team from membership, not the body', async () => {
    const token = await bearer('alice');
    const response = await fetch(
      new Request(url('/applications/warehouse-take'), {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ ...intent, org: 'evil', team: 'evil' }),
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining('cannot be set'),
    });

    const created = await fetch(
      new Request(url('/applications/warehouse-take'), {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(intent),
      }),
    );
    expect(created.status).toBe(200);
    const body = (await created.json()) as { org: string; team: string; owner: string };
    expect(body).toMatchObject({ org: 'acme', team: 'warehouse', owner: 'alice' });
    const wd = [...kube.resources.values()].find(
      (document) => document.kind === 'WorkloadDeployment',
    ) as {
      metadata: { labels: Record<string, string>; namespace: string };
    };
    expect(wd.metadata.namespace).toBe('wasmcloud');
    expect(wd.metadata.labels[ORG_LABEL]).toBe('acme');
    expect(wd.metadata.labels[TEAM_LABEL]).toBe('warehouse');
    expect(wd.metadata.labels[APPLICATION_LABEL]).toBe('warehouse-take');
  });

  it('allows same-team mutate and denies other teams and orgs', async () => {
    const alice = await bearer('alice');
    expect(
      (
        await fetch(
          new Request(url('/applications/warehouse-take'), {
            method: 'POST',
            headers: { authorization: `Bearer ${alice}`, 'content-type': 'application/json' },
            body: JSON.stringify(intent),
          }),
        )
      ).status,
    ).toBe(200);

    const aliceDelete = await fetch(
      new Request(url('/applications/warehouse-take'), {
        method: 'DELETE',
        headers: { authorization: `Bearer ${alice}` },
      }),
    );
    expect(aliceDelete.status).toBe(200);

    expect(
      (
        await fetch(
          new Request(url('/applications/warehouse-take'), {
            method: 'POST',
            headers: { authorization: `Bearer ${alice}`, 'content-type': 'application/json' },
            body: JSON.stringify(intent),
          }),
        )
      ).status,
    ).toBe(200);

    const bob = await bearer('bob');
    expect(
      (
        await fetch(
          new Request(url('/applications/warehouse-take'), {
            method: 'DELETE',
            headers: { authorization: `Bearer ${bob}` },
          }),
        )
      ).status,
    ).toBe(403);

    const eve = await bearer('eve');
    expect(
      (
        await fetch(
          new Request(url('/applications/warehouse-take'), {
            method: 'DELETE',
            headers: { authorization: `Bearer ${eve}` },
          }),
        )
      ).status,
    ).toBe(403);

    const admin = await bearer('admin');
    expect(
      (
        await fetch(
          new Request(url('/applications/warehouse-take'), {
            method: 'DELETE',
            headers: { authorization: `Bearer ${admin}` },
          }),
        )
      ).status,
    ).toBe(200);
  });

  it.each([false, true])(
    'completes PKCE login and validates bearer issuer (bindings: %s)',
    async (useBindings) => {
      const issuer = useBindings ? 'https://configured.example.test' : ISSUER;
      if (useBindings) {
        setGuests({
          platform: {
            get: (key: string) =>
              (
                ({ issuer, namespace: 'hydrated', members: JSON.stringify(members) }) as Record<
                  string,
                  string
                >
              )[key],
          },
          tokens: {
            get: async (key: string) => key,
            reveal: async (key: string) => ({
              value: (
                {
                  bootstrapPassword: 's3cret',
                  sessionSecret: 'session-secret',
                  kubeToken: 'sa-token',
                } as Record<string, string>
              )[key],
            }),
          },
        });
        fetch = createApp({
          useBindings: true,
          keyService: keys,
          kube: { send: (request) => kube.send(request as KubeRequest) },
        }).fetch;
      }
      const discovery = await fetch(new Request(url('/.well-known/openid-configuration')));
      expect(await discovery.json()).toMatchObject({ issuer });
      const pkce = await generatePkce();
      const authorize = `/oauth/authorize?response_type=code&client_id=${CLI_CLIENT_ID}&redirect_uri=${encodeURIComponent('http://127.0.0.1:8765/callback')}&scope=openid%20profile&code_challenge=${pkce.codeChallenge}&code_challenge_method=S256&state=s1`;
      const loginPage = await fetch(
        new Request(url(authorize), { headers: { accept: 'text/html' } }),
      );
      expect(loginPage.status).toBe(302);
      expect(loginPage.headers.get('location')).toContain('/login?return_to=');

      const loggedIn = await fetch(
        new Request(url('/login'), {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            username: 'admin',
            password: 's3cret',
            return_to: authorize,
          }).toString(),
        }),
      );
      expect(loggedIn.status).toBe(302);
      const cookie = loggedIn.headers.get('set-cookie');
      expect(cookie).toContain('df_session=');

      const granted = await fetch(
        new Request(url(authorize), {
          headers: { cookie: cookie?.split(';')[0] ?? '', accept: 'text/html' },
        }),
      );
      expect(granted.status).toBe(302);
      const redirected = new URL(granted.headers.get('location') ?? '', 'http://127.0.0.1:8765');
      const code = redirected.searchParams.get('code');
      expect(code).toBeString();

      const tokenResponse = await fetch(
        new Request(url('/oauth/token'), {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code: code ?? '',
            redirect_uri: 'http://127.0.0.1:8765/callback',
            client_id: CLI_CLIENT_ID,
            code_verifier: pkce.codeVerifier,
          }).toString(),
        }),
      );
      expect(tokenResponse.status).toBe(200);
      const tokens = (await tokenResponse.json()) as { access_token: string };
      expect(tokens.access_token).toBeString();
      const claims = JSON.parse(
        Buffer.from(tokens.access_token.split('.')[1]!, 'base64url').toString(),
      );
      expect(claims.iss).toBe(issuer);

      const deployed = await fetch(
        new Request(url('/applications/warehouse-take'), {
          method: 'POST',
          headers: {
            authorization: `Bearer ${tokens.access_token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(intent),
        }),
      );
      expect(deployed.status).toBe(200);
      const userinfo = await fetch(
        new Request(url('/oauth/userinfo'), {
          headers: { authorization: `Bearer ${tokens.access_token}` },
        }),
      );
      expect(await userinfo.json()).toMatchObject({
        org: 'acme',
        team: 'platform',
        roles: ['org-admin'],
      });
      if (useBindings) {
        expect(await deployed.json()).toMatchObject({ namespace: 'hydrated' });
        const wrongIssuer = await bearer('admin');
        expect(
          (
            await fetch(
              new Request(url('/applications/warehouse-take'), {
                headers: { authorization: `Bearer ${wrongIssuer}` },
              }),
            )
          ).status,
        ).toBe(401);
      }
    },
  );

  it('makes concurrent requests await the same complete binding initialization', async () => {
    const gate = Promise.withResolvers<string>();
    const started = Promise.withResolvers<void>();
    const reads: string[] = [];
    setGuests({
      platform: {
        get: async (key: string) => {
          reads.push(key);
          if (key === 'issuer') {
            started.resolve();
            return gate.promise;
          }
          return key === 'namespace' ? 'configured-namespace' : undefined;
        },
      },
      tokens: { get: async (key: string) => key, reveal: async () => 'configured-secret' },
    });
    const app = createApp({ useBindings: true });
    const first = app.fetch(new Request(url('/health')));
    await started.promise;
    let completed = false;
    const second = app.fetch(new Request(url('/health'))).then((response) => {
      completed = true;
      return response;
    });
    await Bun.sleep(0);
    expect(completed).toBe(false);
    gate.resolve('https://configured.example.test');
    for (const response of await Promise.all([first, second])) {
      expect(await response.json()).toMatchObject({ namespace: 'configured-namespace' });
    }
    expect(reads.filter((key) => key === 'issuer')).toHaveLength(1);
    expect(
      await (await app.fetch(new Request(url('/.well-known/openid-configuration')))).json(),
    ).toMatchObject({ issuer: 'https://configured.example.test' });
  });
  async function applicationRequest(
    method = 'POST',
    body: unknown = intent,
    sub = 'admin',
    name = intent.witName,
  ) {
    return fetch(
      new Request(url(`/applications/${name}`), {
        method,
        headers: {
          authorization: `Bearer ${await bearer(sub)}`,
          'content-type': 'application/json',
        },
        ...(method === 'GET' || method === 'DELETE' ? {} : { body: JSON.stringify(body) }),
      }),
    );
  }

  it('updates and reads existing workloads without rotating control secrets', async () => {
    expect((await applicationRequest()).status).toBe(200);
    const secretPath = '/api/v1/namespaces/wasmcloud/secrets/warehouse-take-control';
    const secret = kube.resources.get(secretPath);
    expect(
      (
        await applicationRequest('PUT', {
          ...intent,
          image: `registry.test/app@sha256:${'b'.repeat(64)}`,
        })
      ).status,
    ).toBe(200);
    expect(kube.resources.get(secretPath)).toEqual(secret);
    const response = await applicationRequest('GET');
    expect(await response.json()).toMatchObject({ ready: true, owner: 'admin', org: 'acme' });
    expect((await applicationRequest('GET', undefined, 'eve')).status).toBe(403);
    expect((await applicationRequest('GET', undefined, 'admin', 'missing')).status).toBe(404);
  });

  it('rejects missing membership, teamless members and mismatched application names', async () => {
    expect(await (await applicationRequest('POST', intent, 'unknown')).json()).toMatchObject({
      reason: 'no-org',
    });
    const noTeam = createApp({
      issuer: ISSUER,
      keyService: keys,
      kube: { send: kube.send },
      members: { admin: { org: 'acme', roles: ['member'] } },
    });
    expect(
      await (
        await noTeam.fetch(
          new Request(url('/applications/warehouse-take'), {
            method: 'POST',
            headers: {
              authorization: `Bearer ${await bearer('admin')}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify(intent),
          }),
        )
      ).json(),
    ).toMatchObject({ reason: 'no-team' });
    expect((await applicationRequest('POST', intent, 'admin', 'other')).status).toBe(400);
    expect((await applicationRequest('DELETE', undefined, 'alice', 'missing')).status).toBe(403);
  });

  it('prevents shared storage ownership and removes associated CronJobs', async () => {
    kube.resources.set(
      '/apis/runtime.wasmcloud.dev/v1alpha1/namespaces/wasmcloud/workloaddeployments/unrelated',
      {
        metadata: { name: 'unrelated' },
        spec: {
          template: {
            spec: { volumes: [{ hostPath: { path: '/var/lib/di-framework/storage/unrelated' } }] },
          },
        },
      },
    );
    const persistent = {
      ...intent,
      persistentStorage: true,
      cronJobs: [
        {
          jobId: 'daily',
          kebabId: 'daily',
          className: 'Jobs',
          methodName: 'run',
          cronExpression: '* * * * *',
          allowConcurrent: false,
        },
      ],
    };
    expect((await applicationRequest('POST', persistent)).status).toBe(200);
    expect((await applicationRequest('PUT', persistent)).status).toBe(200);
    const conflict = await applicationRequest('POST', { ...persistent, witName: 'other' });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({
      error: 'storage-conflict',
      owner: intent.witName,
    });
    expect((await applicationRequest('DELETE')).status).toBe(200);
    expect([...kube.resources.keys()].some((path) => path.includes('/cronjobs/'))).toBe(false);
  });

  it.each(['create', 'read', 'update'])(
    'reports Kubernetes failures during %s',
    async (operation) => {
      if (operation !== 'create') expect((await applicationRequest()).status).toBe(200);
      const send = kube.send;
      kube.send = async (request) => {
        if (request.url.endsWith('/services/warehouse-take') && operation === 'read')
          return { status: 503, body: '{}' };
        if (request.method === 'POST' && operation === 'create') return { status: 503, body: '{}' };
        if (request.method === 'PUT' && operation === 'update') return { status: 503, body: '{}' };
        return send(request);
      };
      const response = await applicationRequest();
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: expect.stringContaining('failed') });
    },
  );

  it('handles intent errors and propagates unexpected backend failures', async () => {
    kube.send = async () => {
      throw new IntentError('invalid binding');
    };
    expect((await applicationRequest()).status).toBe(400);
    kube.send = async () => {
      throw new Error('unexpected backend error');
    };
    await expect(applicationRequest()).rejects.toThrow('unexpected backend error');
  });

  it('uses defaults when optional bindings are absent or malformed', async () => {
    const app = createApp({ useBindings: true, members: {} });
    expect(await (await app.fetch(new Request(url('/health')))).json()).toMatchObject({
      namespace: 'wasmcloud',
    });
    setGuests({
      platform: { get: () => undefined },
      tokens: { get: async () => 'handle', reveal: async () => ({ value: 123 }) },
    });
    expect((await createApp({ useBindings: true }).fetch(new Request(url('/health')))).status).toBe(
      200,
    );
  });

  it('renders login errors and only redirects to same-origin authorization pages', async () => {
    const page = await fetch(new Request(url('/login?return_to=%3Cscript%3E')));
    expect(await page.text()).toContain('&lt;script&gt;');
    const invalid = await fetch(
      new Request(url('/login'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'wrong' }),
      }),
    );
    expect(invalid.status).toBe(401);
    expect(await invalid.text()).toContain('Invalid username or password');
    for (const [return_to, expected] of [
      ['/elsewhere', '/'],
      ['http://evil.test/oauth/authorize', '/'],
      ['bad url', '/'],
      ['http://deploy.local/oauth/authorize?state=x', '/oauth/authorize?state=x'],
    ] as const) {
      const response = await fetch(
        new Request(url('/login'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: 'admin', password: 's3cret', return_to }),
        }),
      );
      expect(response.headers.get('location')).toBe(expected);
    }
  });

  it('rejects a request whose authentication context was removed before the handler', async () => {
    const request = new Request(url('/applications/warehouse-take'), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await bearer('admin')}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(intent),
    });
    Object.defineProperty(request, 'principal', {
      set() {
        delete (request as unknown as Record<symbol, unknown>)[
          Symbol.for('@di-framework/auth:principal')
        ];
      },
    });
    expect((await fetch(request)).status).toBe(401);
    expect(kube.resources.size).toBe(0);
  });

  it('rechecks membership after asynchronous policy evaluation', async () => {
    const current: Record<string, { org: string; roles: string[] }> = {
      admin: { org: 'acme', roles: ['org-admin'] },
    };
    const manager = spyOn(authz, 'policyAuthorizationManager').mockReturnValue({
      authorize: async () => {
        delete current.admin;
        return { allowed: true };
      },
    });
    let app: ReturnType<typeof createApp>;
    try {
      app = createApp({
        issuer: ISSUER,
        keyService: keys,
        members: current,
        kube: { send: kube.send },
      });
    } finally {
      manager.mockRestore();
    }
    const response = await app.fetch(
      new Request(url('/applications/warehouse-take'), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${await bearer('admin')}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(intent),
      }),
    );
    expect(await response.json()).toMatchObject({ reason: 'no-org' });
    expect(kube.resources.size).toBe(0);
  });
});
