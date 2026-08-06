import { describe, expect, it } from 'bun:test';
import { authorization } from './index';

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
});
