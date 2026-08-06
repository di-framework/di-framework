import { describe, expect, it, spyOn } from 'bun:test';
import { auth, opaAuthorizationManager, router, runAuthMain } from './index.ts';

describe('auth example', () => {
  it('refuses an unauthenticated request', async () => {
    const response = await router.fetch(new Request('https://api.example.com/notes'));
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: 'no_credential' });
  });

  it('leaves the health route and the opted-out route public', async () => {
    expect((await router.fetch(new Request('https://api.example.com/health'))).status).toBe(200);
    expect((await router.fetch(new Request('https://api.example.com/whoami'))).status).toBe(200);
  });

  it('serves a request carrying a session cookie', async () => {
    const user = await auth.passwords.createUser({
      identifier: `cookie-${crypto.randomUUID()}@example.com`,
      password: 'correct horse battery staple',
    });
    const session = await auth.sessions.create({ subject: user.id });

    const response = await router.fetch(
      new Request('https://api.example.com/notes', {
        headers: { cookie: `__Host-sid=${session.token}` },
      }),
    );
    expect(response.status).toBe(200);
  });

  it('serves a request carrying a bearer token', async () => {
    const { token } = await auth.tokens!.issueAccessToken({ subject: 'machine-client' });
    const response = await router.fetch(
      new Request('https://api.example.com/notes', {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(response.status).toBe(200);
  });

  // The three-state result at work: a bad bearer token halts the chain rather
  // than falling through the api-key strategy and ending up anonymous.
  it('rejects a forged token instead of downgrading to anonymous', async () => {
    const response = await router.fetch(
      new Request('https://api.example.com/notes', {
        headers: { authorization: 'Bearer eyJhbGciOiJub25lIn0.eyJzdWIiOiJhZG1pbiJ9.' },
      }),
    );
    expect(response.status).toBe(401);
  });

  it('requires a CSRF token for a cookie-authenticated mutation', async () => {
    const user = await auth.passwords.createUser({
      identifier: `csrf-${crypto.randomUUID()}@example.com`,
      password: 'correct horse battery staple',
    });
    const session = await auth.sessions.create({ subject: user.id });
    const cookie = `__Host-sid=${session.token}`;
    const headers = { cookie, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' };
    const body = JSON.stringify({ text: 'note' });

    const without = await router.fetch(
      new Request('https://api.example.com/notes', { method: 'POST', headers, body }),
    );
    expect(without.status).toBe(403);

    const withToken = await router.fetch(
      new Request('https://api.example.com/notes', {
        method: 'POST',
        headers: { ...headers, 'x-csrf-token': await auth.csrf!.issue(session.record.id) },
        body,
      }),
    );
    expect(withToken.status).toBe(200);
  });

  // Bearer requests carry no ambient credential, so forcing a CSRF token on them
  // would be pure friction.
  it('does not require a CSRF token for a bearer mutation', async () => {
    const { token } = await auth.tokens!.issueAccessToken({ subject: 'machine-client' });
    const response = await router.fetch(
      new Request('https://api.example.com/notes', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'from a script' }),
      }),
    );
    expect(response.status).toBe(200);
  });
  it('shows an OPA-shaped remote authorization manager', async () => {
    let body: unknown;
    const manager = opaAuthorizationManager(
      'https://opa.example/v1/data/library/allow',
      async (_input, init) => {
        body = JSON.parse(String(init?.body));
        return Response.json({ result: true });
      },
    );

    const decision = await manager.authorize(
      { sub: 'u1', method: 'session', authTime: 1 },
      { transport: 'http', metadata: { resource: 'notes', action: 'admin:read' } },
    );
    expect(decision).toEqual({ allowed: true });
    expect(body).toMatchObject({
      input: {
        principal: { sub: 'u1' },
        metadata: { resource: 'notes', action: 'admin:read' },
      },
    });
  });

  // Runs the full walkthrough via the injectable CLI gate (covers `main()` and
  // the `isMain` entry path). Run last since it clears the container as its
  // final step.
  it('runs the full walkthrough via the CLI main gate', async () => {
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      await runAuthMain(true);
    } finally {
      log.mockRestore();
    }
  });
});
