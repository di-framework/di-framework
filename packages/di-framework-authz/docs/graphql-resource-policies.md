# GraphQL Resource-Policy Bindings (`@di-framework/authz/graphql`)

## Overview

`@di-framework/authz/graphql` connects `@di-framework/authz` resource policies directly to GraphQL queries, mutations, subscriptions, and field resolvers. It reuses the exact same AST, evaluator, `ResourcePolicy` definitions, and `ResourceProvider` contracts introduced by PR #116 without introducing a parallel policy language.

---

## Key Features

1. **Same Policy AST & Evaluator**: Uses `policyAuthorizationManager` and `compilePolicies()` directly.
2. **Fail-Closed Declarations**: Missing or ambiguous resource IDs and actions fail closed immediately.
3. **Information Leakage Protections**: Internal decision categories, rule IDs (`category`, `ruleIds`), and policy ASTs are accessible to internal logs/hooks (`onDenied`) but **never serialized to GraphQL clients**.
4. **Flexible Resource ID Resolution**: Supports argument values (`args[idArg]`), custom getter functions (`idArg: (args, parent) => ...`), or parent entity properties (`idField: 'id'`).
5. **Provider Consistency**: Evaluates `ResourceProvider.load(id, context)` before evaluating policy conditions for member operations.

---

## Example Usage

```ts
import { ResourcePolicy, Policy, Allow, Owner, HasRole } from '@di-framework/authz';
import { GraphQLResourceAuthorization, protectGraphQLField } from '@di-framework/authz/graphql';

@ResourcePolicy({ resource: 'document' })
export class DocumentPolicy {
  @Allow({ actions: ['read', 'update'] })
  @Owner({ subjectPath: 'id', resourcePath: 'ownerId' })
  ownerAccess() {}

  @Allow({ actions: ['read', 'list'] })
  @HasRole('admin')
  adminAccess() {}
}

// Option A: Field Resolver Wrapper
export const documentQueryResolver = protectGraphQLField(
  DocumentPolicy,
  async (parent, args, ctx) => {
    return ctx.db.findDocument(args.id);
  },
  { action: 'read', idArg: 'id' }
);

// Option B: Decorator Integration
export class DocumentResolver {
  @GraphQLResourceAuthorization(DocumentPolicy, { action: 'update', idArg: 'id' })
  async updateDocument(parent: any, args: { id: string; title: string }, ctx: any) {
    return ctx.db.updateDocument(args.id, { title: args.title });
  }
}
```

---

## Client Error Responses

When authorization fails, the client receives a standard GraphQL error without internal detail:

```json
{
  "errors": [
    {
      "message": "Not authorized.",
      "extensions": {
        "code": "FORBIDDEN"
      }
    }
  ]
}
```
