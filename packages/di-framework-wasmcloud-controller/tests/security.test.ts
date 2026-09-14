import { describe, expect, it } from 'bun:test';
import { createHmac } from 'node:crypto';
import { createPrincipal } from '@di-framework/auth';
import { Kube } from '../src/bindings';
import { parseDeployIntent } from '../src/intent';
import { KubeError, kubeJson, namespacedPath } from '../src/kube';
import { mapSubject, parseMembers, resolveMembership } from '../src/membership';
import {
  decodeSession,
  encodeSession,
  readSessionCookie,
  sessionCookieHeader,
} from '../src/session';

describe('controller input and membership', () => {
  it('ignores malformed membership and preserves only typed claims', () => {
    for (const raw of [undefined, '', ' ', '{', 'null', '[]', '3'])
      expect(parseMembers(raw)).toEqual({});
    const table = parseMembers(
      JSON.stringify({
        null: null,
        array: [],
        scalar: 'x',
        empty: { org: ' ' },
        alice: { org: 'acme', team: 'team', roles: ['admin', 2] },
        bob: { org: 'acme', team: 2 },
      }),
    );
    expect(table).toEqual({
      alice: { org: 'acme', team: 'team', roles: ['admin'] },
      bob: { org: 'acme', roles: [] },
    });
    const principal = createPrincipal({
      sub: 'alice',
      method: 'bearer',
      scope: ['read'],
      claims: { org: 'wrong', team: 'wrong', roles: ['member'] },
    });
    expect(resolveMembership(principal, table)).toEqual(table.alice);
    expect(mapSubject(principal, table)).toMatchObject({
      id: 'alice',
      roles: ['admin'],
      scopes: ['read'],
      claims: { org: 'acme', team: 'team' },
    });
    expect(resolveMembership(principal, {})).toEqual({
      org: 'wrong',
      team: 'wrong',
      roles: ['member'],
    });
    expect(
      resolveMembership(
        createPrincipal({ sub: 'bob', method: 'bearer', claims: { roles: ['fallback', 1] } }),
        table,
      )?.roles,
    ).toEqual(['fallback']);
    const unknown = createPrincipal({ sub: 'unknown', method: 'bearer', claims: { org: ' ' } });
    expect(resolveMembership(unknown, {})).toBeUndefined();
    expect(mapSubject(unknown, {})).toMatchObject({ roles: [], scopes: [] });
  });

  it('validates required fields and filters optional binding values', () => {
    const valid = {
      application: 'app',
      witName: 'app',
      image: `registry/app@sha256:${'1'.repeat(64)}`,
      deploymentDigest: 'digest',
    };
    for (const body of [null, [], 'app'])
      expect(() => parseDeployIntent(body)).toThrow(/JSON object/);
    expect(() => parseDeployIntent({ ...valid, application: ' ' })).toThrow(/application/);
    expect(() => parseDeployIntent({ ...valid, ingress: 'yes' })).toThrow(/boolean/);
    expect(() => parseDeployIntent({ ...valid, bindings: [null] })).toThrow(/binding/);
    const parsed = parseDeployIntent({
      ...valid,
      workload: 'shared',
      allowedIpNameLookups: ['example.test', 1],
      bindings: [
        {
          className: 'Database',
          name: 'db',
          kind: 'Postgres',
          package: 'wasmcloud:postgres',
          version: '0.2.0',
          interfaces: ['query', 1],
          config: { db: 'app', ignored: false },
          secretFrom: 'db-secret',
          configFrom: 'db-config',
        },
      ],
    });
    expect(parsed.bindings[0]).toMatchObject({
      interfaces: ['query'],
      config: { db: 'app' },
      secretFrom: 'db-secret',
      configFrom: 'db-config',
    });
    expect(parsed.allowedIpNameLookups).toEqual(['example.test']);
    expect(parsed.workload).toBe('shared');
    expect(
      parseDeployIntent({
        ...valid,
        bindings: [
          {
            ...parsed.bindings[0],
            interfaces: undefined,
            config: null,
            secretFrom: 1,
            configFrom: 1,
          },
        ],
      }).bindings[0]?.interfaces,
    ).toEqual([]);
  });
});

describe('controller sessions', () => {
  it('rejects tampered, expired, malformed, and wrongly typed signed sessions', async () => {
    const token = await encodeSession({ sub: 'alice', exp: 200 }, 'secret');
    expect(await decodeSession(token, 'secret', 100)).toEqual({ sub: 'alice', exp: 200 });
    expect(await decodeSession(token, 'secret', 200)).toBeUndefined();
    expect(await decodeSession(token, 'wrong', 100)).toBeUndefined();
    expect(await decodeSession('bad', 'secret')).toBeUndefined();
    for (const raw of ['{', 'null', '{"sub":1,"exp":200}', '{"sub":"alice","exp":"200"}']) {
      const body = Buffer.from(raw).toString('base64url');
      const mac = createHmac('sha256', 'secret').update(body).digest('base64url');
      expect(await decodeSession(`${body}.${mac}`, 'secret', 100)).toBeUndefined();
    }
    const cookie = sessionCookieHeader(token, true);
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('HttpOnly');
    expect(readSessionCookie(new Request('https://deploy.test', { headers: { cookie } }))).toBe(
      token,
    );
    expect(readSessionCookie(new Request('https://deploy.test'))).toBeUndefined();
  });
});

it('preserves Kubernetes failures and handles empty or non-JSON responses', async () => {
  const calls: unknown[] = [];
  const settings = { namespace: 'a/b', kubeApi: 'https://kube.test/', kubeToken: 'secret' };
  for (const body of ['', 'not json', '{"ok":true}']) {
    const kube = new Kube({
      send: async (request) => {
        calls.push(request);
        return { status: 502, body };
      },
    });
    const result = await kubeJson(kube, settings, {
      method: 'PUT',
      path: namespacedPath('/api', 'a/b', 'secrets', 'one/two'),
      body: { key: 'value' },
    });
    expect(result.status).toBe(502);
    expect(result.value).toEqual(body.startsWith('{') ? { ok: true } : undefined);
  }
  expect(calls[0]).toMatchObject({
    url: 'https://kube.test/api/namespaces/a%2Fb/secrets/one%2Ftwo',
    headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
    body: '{"key":"value"}',
  });
  expect(new KubeError('failed')).toMatchObject({ status: 502, name: 'KubeError' });
});
