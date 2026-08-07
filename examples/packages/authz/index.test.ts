import { describe, expect, it } from 'bun:test';
import { auth, authorization, DocumentPolicy, router } from './index';

const principal = (sub: string, roles: string[] = [], scope: string[] = []) => ({
  sub,
  method: 'bearer' as const,
  authTime: 1,
  scope,
  claims: { roles },
});
const decide = (id: string, action: string, who = principal('ada')) =>
  authorization.authorize(who, {
    transport: 'http',
    request: Object.assign(new Request(`https://example.test/documents/${id}`), { params: { id } }),
    metadata: { resource: 'document', action, idParam: 'id' },
  });
describe('authz example', () => {
  it('keeps policy declaration methods inert', () => {
    const policy = new DocumentPolicy();
    expect(policy.read()).toBeUndefined();
    expect(policy.own()).toBeUndefined();
    expect(policy.admin()).toBeUndefined();
    expect(policy.locked()).toBeUndefined();
  });

  it('covers scope, owner, admin, locked, and missing-resource decisions', async () => {
    expect(
      (await decide('open', 'read', principal('grace', [], ['documents:read']))).allowed,
    ).toBeTrue();
    expect((await decide('open', 'update')).allowed).toBeTrue();
    expect((await decide('open', 'delete', principal('root', ['admin']))).allowed).toBeTrue();
    expect((await decide('locked', 'delete', principal('root', ['admin']))).allowed).toBeFalse();
    expect(
      (await decide('missing', 'read', principal('grace', [], ['documents:read']))).detail,
    ).toMatchObject({ category: 'resource-unavailable' });
  });

  it('serves every authorized document route', async () => {
    if (!auth.tokens) throw new Error('Authz example is missing JWT support');
    const { token } = await auth.tokens.issueAccessToken({
      subject: 'ada',
      claims: { scope: 'documents:read', roles: ['admin'] },
    });
    const headers = { authorization: `Bearer ${token}` };

    const list = await router.fetch(new Request('https://example.test/documents', { headers }));
    expect(list.status).toBe(200);
    expect(await list.json()).toHaveLength(2);

    const read = await router.fetch(
      new Request('https://example.test/documents/open', { headers }),
    );
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ id: 'open' });

    const update = await router.fetch(
      new Request('https://example.test/documents/open', {
        method: 'PATCH',
        headers: { ...headers, 'content-type': 'application/json' },
        body: '{}',
      }),
    );
    expect(update.status).toBe(200);
    expect((await update.json()) as { updated: string }).toEqual({ updated: 'open' });

    const remove = await router.fetch(
      new Request('https://example.test/documents/open', { method: 'DELETE', headers }),
    );
    expect(remove.status).toBe(200);
    expect((await remove.json()) as { deleted: string }).toEqual({ deleted: 'open' });
  });
});
