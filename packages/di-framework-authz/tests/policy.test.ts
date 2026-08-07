import { beforeEach, describe, expect, it } from 'bun:test';
import {
  Allow,
  compilePolicies,
  Deny,
  Equals,
  evaluatePolicy,
  HasRole,
  HasScope,
  Owner,
  Policy,
  PolicyRegistry,
  parsePolicies,
  policyAuthorizationManager,
  policyRegistry,
  printPolicies,
  resourceForPolicy,
} from '../index.ts';

function buildDocument() {
  class DocumentPolicy {
    @Allow('read') @HasScope('documents:read') read() {
      throw new Error('never');
    }
    @Allow('update', 'delete') @Owner() own() {
      throw new Error('never');
    }
    @Allow('delete') @HasRole('admin') admin() {
      throw new Error('never');
    }
    @Deny('update', 'delete') @Equals('resource.locked', true) locked() {
      throw new Error('never');
    }
  }
  Policy('document')(DocumentPolicy);
  return compilePolicies();
}
const subject = { id: 'u1', roles: [], scopes: ['documents:read'], claims: {} };

describe('policy authoring and EBNF', () => {
  beforeEach(() => policyRegistry.clear());
  it('collects methods without constructing or invoking them and round trips deterministically', () => {
    const document = buildDocument();
    const text = printPolicies(document);
    expect(printPolicies(parsePolicies(text))).toBe(text);
    expect(text).toContain('DocumentPolicy');
  });
  it('parses comments, alternatives, and structural equals values', () => {
    const parsed = parsePolicies(
      '(* hi *) policy P = "thing"; allow P read = ("read" | "list"), ? equals "resource.meta" {"x": 1} ?;',
    );
    expect(parsed.policies[0]?.rules[0]?.actions).toEqual(['read', 'list']);
  });
  it('rejects invalid declarations and EBNF', () => {
    expect(() => Allow()(class X {}, 'x')).toThrow(/actions/);
    expect(() => parsePolicies('allow P x = "read";')).toThrow(/Unknown policy/);
    expect(() => parsePolicies('policy P = "x"; allow P x = "r", ? nope "x" ?;')).toThrow(
      /Unsupported/,
    );
    expect(() => parsePolicies(String.raw`policy P = "\x";`)).toThrow(/Malformed string/);
    expect(() =>
      parsePolicies('policy P = "x"; allow P x = "read", ? equals "resource.value" nope ?;'),
    ).toThrow(/Malformed equals JSON/);
  });
  it('supports isolated registries', () => {
    const registry = new PolicyRegistry();
    class P {}
    registry.policy(P, 'x');
    registry.rule(P, 'read', 'allow', ['read']);
    expect(registry.compile().policies).toHaveLength(1);
    expect(compilePolicies().policies).toHaveLength(0);
  });

  it('records static rule declarations against their policy class', () => {
    class StaticPolicy {
      @Allow('read')
      static read() {}
    }
    Policy('static-document')(StaticPolicy);

    expect(compilePolicies().policies[0]).toMatchObject({
      resource: 'static-document',
      rules: [{ actions: ['read'], effect: 'allow' }],
    });
  });

  it('resolves policy resources by constructor identity', () => {
    const First = class SameName {};
    const Second = class SameName {};
    Policy('first')(First);
    Policy('second')(Second);

    expect(resourceForPolicy(First)).toBe('first');
    expect(resourceForPolicy(Second)).toBe('second');
  });
});

describe('evaluation and providers', () => {
  beforeEach(() => policyRegistry.clear());
  it('applies AND, OR, explicit deny, default deny, and stable IDs', () => {
    const document = buildDocument();
    expect(
      evaluatePolicy(document, {
        resource: 'document',
        action: 'read',
        subject,
        value: { ownerId: 'x' },
      }).allowed,
    ).toBeTrue();
    expect(
      evaluatePolicy(document, {
        resource: 'document',
        action: 'update',
        subject,
        value: { ownerId: 'u1' },
      }).category,
    ).toBe('allow-rule-matched');
    expect(
      evaluatePolicy(document, {
        resource: 'document',
        action: 'update',
        subject,
        value: { ownerId: 'u1', locked: true },
      }),
    ).toMatchObject({
      allowed: false,
      category: 'explicit-deny',
      ruleIds: ['DocumentPolicy.locked'],
    });
    expect(
      evaluatePolicy(document, { resource: 'document', action: 'create', subject, value: {} })
        .category,
    ).toBe('no-matching-allow');
  });
  it('maps subjects and loads member resources through direct providers', async () => {
    const document = buildDocument();
    let loads = 0;
    const manager = policyAuthorizationManager({
      policies: document,
      providers: {
        document: {
          load: async (id) => {
            loads++;
            return id === 'd1' ? { ownerId: 'u1' } : null;
          },
        },
      },
    });
    const principal = {
      sub: 'u1',
      method: 'bearer' as const,
      authTime: 1,
      scope: ['documents:read'],
      claims: { roles: ['admin'] },
    };
    const request = Object.assign(new Request('https://example.test/documents/d1'), {
      params: { id: 'd1' },
    });
    const result = await manager.authorize(principal, {
      transport: 'http',
      request,
      metadata: { resource: 'document', action: 'update', idParam: 'id' },
    });
    expect(result.allowed).toBeTrue();
    expect(loads).toBe(1);
    await manager.authorize(principal, {
      transport: 'http',
      request,
      metadata: { resource: 'document', action: 'list', collection: true },
    });
    expect(loads).toBe(1);
  });

  it('matches any listed role but requires every listed scope', () => {
    class PredicatePolicy {
      @Allow('role') @HasRole('admin', 'editor') role() {}
      @Allow('scope') @HasScope('documents:read', 'documents:write') scope() {}
    }
    Policy('predicate')(PredicatePolicy);
    const document = compilePolicies();
    const input = { id: 'u1', roles: ['editor'], scopes: ['documents:read'], claims: {} };

    expect(
      evaluatePolicy(document, { resource: 'predicate', action: 'role', subject: input }).allowed,
    ).toBeTrue();
    expect(
      evaluatePolicy(document, { resource: 'predicate', action: 'scope', subject: input }).allowed,
    ).toBeFalse();
    expect(
      evaluatePolicy(document, {
        resource: 'predicate',
        action: 'scope',
        subject: { ...input, scopes: ['documents:read', 'documents:write'] },
      }).allowed,
    ).toBeTrue();
  });

  it('compares nested JSON values structurally', () => {
    class StructuralPolicy {
      @Allow('read') @Equals('resource.metadata', { flags: ['a', 'b'], rank: 1 }) read() {}
    }
    Policy('structural')(StructuralPolicy);
    const document = compilePolicies();

    expect(
      evaluatePolicy(document, {
        resource: 'structural',
        action: 'read',
        subject,
        value: { metadata: { rank: 1, flags: ['a', 'b'] } },
      }).allowed,
    ).toBeTrue();
    expect(
      evaluatePolicy(document, {
        resource: 'structural',
        action: 'read',
        subject,
        value: { metadata: { rank: 1, flags: ['a'] } },
      }).allowed,
    ).toBeFalse();
  });

  it('snapshots the decorator registry when a manager is created', async () => {
    const manager = policyAuthorizationManager({ providers: {} });
    class LatePolicy {
      @Allow('read') read() {}
    }
    Policy('late')(LatePolicy);

    await expect(
      manager.authorize(
        { sub: 'u1', method: 'bearer', authTime: 1 },
        {
          transport: 'http',
          request: new Request('https://example.test/late'),
          metadata: { resource: 'late', action: 'read', collection: true },
        },
      ),
    ).rejects.toThrow("No policy configured for resource 'late'");
  });
});
