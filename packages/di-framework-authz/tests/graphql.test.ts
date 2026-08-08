import { describe, expect, it } from 'bun:test';
import {
  evaluateGraphQLResourcePolicy,
  GraphQLResourceAuthorization,
  GraphQLResourcePolicyError,
  protectGraphQLField,
  ResourceAction,
} from '../graphql.ts';
import { Allow, HasRole, Owner, Policy, policyAuthorizationManager } from '../index.ts';

@Policy('article')
class ArticlePolicy {
  @Allow('read', 'update')
  @Owner({ subjectPath: 'subject.id', resourcePath: 'resource.authorId' })
  authorAccess() {}

  @Allow('read', 'list', 'create', 'delete')
  @HasRole('admin')
  adminAccess() {}
}

const mockProvider = {
  async load(id: string) {
    if (id === 'infra-error') throw new Error('Database connection failed');
    if (id === 'art-1') return { id: 'art-1', authorId: 'user-author', title: 'Hello World' };
    if (id === 'art-2') return { id: 'art-2', authorId: 'user-other', title: 'Private Post' };
    return null;
  },
};

const manager = policyAuthorizationManager({
  providers: { article: mockProvider },
});

describe('GraphQL Resource-Policy Bindings', () => {
  it('allows owner to read and update an article', async () => {
    const ctxAuthor = { user: { sub: 'user-author', roles: [] } };

    // Query read
    await expect(
      evaluateGraphQLResourcePolicy(
        ArticlePolicy,
        null,
        { id: 'art-1' },
        ctxAuthor,
        {
          fieldName: 'getArticle',
        },
        { manager },
      ),
    ).resolves.toBeUndefined();

    // Mutation update
    await expect(
      evaluateGraphQLResourcePolicy(
        ArticlePolicy,
        null,
        { id: 'art-1' },
        ctxAuthor,
        {
          fieldName: 'updateArticle',
        },
        { manager },
      ),
    ).resolves.toBeUndefined();
  });

  it('denies non-owner without admin role', async () => {
    const ctxOther = { user: { sub: 'user-other', roles: [] } };

    await expect(
      evaluateGraphQLResourcePolicy(
        ArticlePolicy,
        null,
        { id: 'art-1' },
        ctxOther,
        {
          fieldName: 'updateArticle',
        },
        { manager },
      ),
    ).rejects.toThrow(GraphQLResourcePolicyError);
  });

  it('allows admin role for collection operations and member actions', async () => {
    const ctxAdmin = { user: { sub: 'user-admin', claims: { roles: ['admin'] } } };

    // List query
    await expect(
      evaluateGraphQLResourcePolicy(
        ArticlePolicy,
        null,
        {},
        ctxAdmin,
        {
          fieldName: 'listArticles',
        },
        { manager },
      ),
    ).resolves.toBeUndefined();

    // Delete mutation
    await expect(
      evaluateGraphQLResourcePolicy(
        ArticlePolicy,
        null,
        { id: 'art-1' },
        ctxAdmin,
        {
          fieldName: 'deleteArticle',
        },
        { manager },
      ),
    ).resolves.toBeUndefined();
  });

  it('fails closed when unauthenticated', async () => {
    await expect(
      evaluateGraphQLResourcePolicy(
        ArticlePolicy,
        null,
        { id: 'art-1' },
        {},
        {
          fieldName: 'getArticle',
        },
        { manager },
      ),
    ).rejects.toThrow('Authentication is required');
  });

  it('fails closed when member action is missing a resource ID', async () => {
    const ctxAuthor = { user: { sub: 'user-author', roles: [] } };

    await expect(
      evaluateGraphQLResourcePolicy(
        ArticlePolicy,
        null,
        {},
        ctxAuthor,
        {
          fieldName: 'updateArticle',
        },
        { manager },
      ),
    ).rejects.toThrow('Resource ID is missing');
  });

  it('supports custom idArg getter function and idField parent lookup', async () => {
    const ctxAuthor = { user: { sub: 'user-author', roles: [] } };

    // idArg as function
    await expect(
      evaluateGraphQLResourcePolicy(
        ArticlePolicy,
        null,
        { input: { articleId: 'art-1' } },
        ctxAuthor,
        { fieldName: 'updateArticle' },
        { manager, idArg: (args) => args.input?.articleId },
      ),
    ).resolves.toBeUndefined();

    // idField on parent
    await expect(
      evaluateGraphQLResourcePolicy(
        ArticlePolicy,
        { articleId: 'art-1' },
        {},
        ctxAuthor,
        { fieldName: 'updateArticle' },
        { manager, idField: 'articleId' },
      ),
    ).resolves.toBeUndefined();
  });

  it('calls onDenied callback with denial information without exposing rule details to client error', async () => {
    const ctxOther = { user: { sub: 'user-other', roles: [] } };
    let capturedDenial: any;

    await expect(
      evaluateGraphQLResourcePolicy(
        ArticlePolicy,
        null,
        { id: 'art-1' },
        ctxOther,
        { fieldName: 'updateArticle' },
        {
          manager,
          onDenied: (denial) => {
            capturedDenial = denial;
            return new Error('Custom client error');
          },
        },
      ),
    ).rejects.toThrow('Custom client error');

    expect(capturedDenial).toBeDefined();
    expect(capturedDenial.resource).toBe('article');
    expect(capturedDenial.action).toBe('update');
  });

  it('bubbles infrastructure errors from resource providers', async () => {
    const ctxAuthor = { user: { sub: 'user-author', roles: [] } };

    await expect(
      evaluateGraphQLResourcePolicy(
        ArticlePolicy,
        null,
        { id: 'infra-error' },
        ctxAuthor,
        {
          fieldName: 'getArticle',
        },
        { manager },
      ),
    ).rejects.toThrow('Database connection failed');
  });

  it('works with protectGraphQLField resolver wrapper', async () => {
    const ctxAuthor = { user: { sub: 'user-author', roles: [] } };
    const rawResolver = async (_source: any, args: { id: string }) => `Resolved ${args.id}`;

    const protectedResolver = protectGraphQLField(ArticlePolicy, rawResolver, {
      manager,
      action: 'read',
    });

    const result = await protectedResolver(null, { id: 'art-1' }, ctxAuthor, {
      fieldName: 'article',
    });
    expect(result).toBe('Resolved art-1');
  });

  it('works with @GraphQLResourceAuthorization decorator and @ResourceAction', async () => {
    class ResolverService {
      @GraphQLResourceAuthorization(ArticlePolicy, { manager })
      @ResourceAction('read')
      async findOne(_parent: any, _args: { id: string }, _ctx: any, _info: any) {
        return 'Article Found';
      }
    }

    const service = new ResolverService();
    const ctxAuthor = { user: { sub: 'user-author', roles: [] } };

    const res = await service.findOne(null, { id: 'art-1' }, ctxAuthor, { fieldName: 'findOne' });
    expect(res).toBe('Article Found');
  });
});
