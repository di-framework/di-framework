# @di-framework/authz

Declarative resource policies for `@di-framework/auth`. The authentication package remains policy-neutral; this companion owns decorator-authored policies, a small ISO/IEC 14977 EBNF interchange format, evaluation, resource loading, and HTTP controller binding.

```ts
import { Allow, Deny, Equals, HasRole, HasScope, Owner, Policy } from '@di-framework/authz';

@Policy('document')
class DocumentPolicy {
  @Allow('read') @HasScope('documents:read') read() {}
  @Allow('update', 'delete') @Owner() own() {}
  @Allow('delete') @HasRole('admin') admin() {}
  @Deny('update', 'delete') @Equals('resource.locked', true) locked() {}
}
```

Policy methods are instance-method metadata declarations: they are never constructed or called. Conditions on one method are ANDed, separate allow methods are alternatives, matching denies take precedence, and the absence of a matching allow denies. With multiple arguments, `@HasRole('admin', 'editor')` matches any listed role, while `@HasScope('read', 'write')` requires every listed scope. To require every role, stack one-role decorators on a method; to accept any scope, use separate allow methods with one scope each.

`compilePolicies()` creates the AST from the registry's current declarations. `printPolicies()` emits deterministic EBNF and `parsePolicies()` accepts that documented subset, so `printPolicies(parsePolicies(text))` is stable. When `policies` is omitted, `policyAuthorizationManager()` takes a one-time registry snapshot at manager creation; import every `@Policy` class before constructing it. Alternatively, pass a string to parse EBNF or a `PolicyDocument` to use directly. These sources are alternatives, never implicit merges.

Providers implement `load(id, context)` and return a trusted record or `null`. Instances can be supplied directly; provider classes and string tokens are resolved through DI. Collection actions do not load a resource. Missing resources deny with `resource-unavailable`; provider failures propagate.

```ts
const authorization = policyAuthorizationManager({
  providers: { document: DocumentResourceProvider },
});
registerAuth({ secret, authorization });

@ResourceAuthorization(DocumentPolicy)
@Controller()
class DocumentsController {
  @Endpoint({ summary: 'Read document' })
  static read = secure.get('/documents/:id', readDocument);
}
```

`@ResourceAuthorization` must be above `@Controller`. It binds direct static routes created by `withAuthRoutes`; route-level `authorization` options conflict, including `false`. A class reference is resolved by constructor identity from the same shared decorator registry; a string resource reference stays decoupled from local policy registration. GET collection/member infer `list`/`read`, POST collection infers `create`, PUT/PATCH member infer `update`, and DELETE member infers `delete`. Use `@ResourceAction()` for custom or ambiguous routes. `@Endpoint` remains responsible for OpenAPI.

Policy categories and decisive rule IDs are available only as authorization detail for logging and denial hooks. HTTP responses remain generic. [GraphQL bindings (#119)](https://github.com/di-framework/di-framework/issues/119) and [OAuth2/OIDC authorization-server support (#118)](https://github.com/di-framework/di-framework/issues/118) are future, separate features.
