import { beforeEach, describe, expect, it } from 'bun:test';
import { keyService, memoryKeyStore, signJwt } from '@di-framework/auth';
import { generatePkce } from '@di-framework/auth/oauth';
import { CLI_CLIENT_ID, createApp } from '../src/app';
import { APPLICATION_LABEL, ORG_LABEL, TEAM_LABEL } from '../src/intent';

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
  image: 'registry.example.com/take:sha256-abc',
  deploymentDigest: 'abc',
  ingress: true,
  worker: false,
  bindings: [],
  hasActors: false,
  persistentStorage: false,
  cronJobs: [],
  queueHandlers: [],
};

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
      kube: { send: kube.send },
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
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('cannot be set') });

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
    const wd = [...kube.resources.values()].find((document) => document.kind === 'WorkloadDeployment') as {
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

  it('completes authorization-code PKCE login for the bootstrap admin', async () => {
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
      new Request(url(authorize), { headers: { cookie: cookie?.split(';')[0] ?? '', accept: 'text/html' } }),
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
  });
});
