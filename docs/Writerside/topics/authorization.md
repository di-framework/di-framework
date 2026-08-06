# Resource Authorization

`@di-framework/authz` adds declarative, resource-oriented policy decisions while `@di-framework/auth` remains policy-neutral. Install both packages when an application needs local resource policies:

```bash
bun add @di-framework/auth @di-framework/authz
```

## Author a policy

```typescript
@Policy('document')
class DocumentPolicy {
  @Allow('read') @HasScope('documents:read') read() {}
  @Allow('update', 'delete') @Owner() own() {}
  @Allow('delete') @HasRole('admin') admin() {}
  @Deny('update', 'delete') @Equals('resource.locked', true) locked() {}
}
```

The methods are metadata containers and are never instantiated or invoked. Conditions on one method are ANDed. Separate allow methods form OR alternatives. Any matching deny wins, and no matching allow denies.

`@Owner()` defaults to `subject.id === resource.ownerId`. `@Equals` structurally compares JSON values; missing attributes and unsafe paths never match. Declarations reject empty actions, mixed allow/deny methods, duplicate resources or rule IDs, unsafe paths, and unsupported predicates.

## EBNF documents

`compilePolicies()` produces the same AST accepted directly by the evaluator. `printPolicies()` emits deterministic ISO/IEC 14977-style EBNF and `parsePolicies()` parses the documented authorization subset, including comments, action alternatives, comma-separated conditions, and the four v1 predicates.

```ebnf
policy DocumentPolicy = "document" ;

allow DocumentPolicy updateOwn =
  "update",
  ? owner "subject.id" "resource.ownerId" ? ;

deny DocumentPolicy locked =
  ("update" | "delete"),
  ? equals "resource.locked" true ? ;
```

`printPolicies(parsePolicies(text))` is canonical and stable. A manager accepts exactly one source: omitted `policies` uses the live decorator registry, a string is parsed, and a `PolicyDocument` is used directly. Sources are not merged.

## Load trusted resources

Providers implement `load(id, context)` and return a trusted record or `null`/`undefined`. Supply a provider instance directly, or a registered class/string token for DI resolution:

```typescript
const authorization = policyAuthorizationManager({
  providers: { document: DocumentResourceProvider },
});
registerAuth({ secret, authorization });
```

Member requests require an ID and invoke the provider. Collection actions do not. Missing IDs or records deny as `resource-unavailable`; provider rejection, timeout, and invalid provider values are infrastructure failures and propagate. Missing policy/provider setup throws rather than silently denying a misconfigured application.

The default subject mapping copies `principal.sub` to `subject.id`, scopes to `subject.scopes`, valid string-array `claims.roles` to roles, and raw claims to `subject.claims`.

## Bind HTTP controllers

```typescript
@ResourceAuthorization(DocumentPolicy)
@Controller()
class DocumentsController {
  @Endpoint({ summary: 'Read a document' })
  static read = secure.get('/documents/:id', readDocument);
}
```

Decorator order is deliberate: `@ResourceAuthorization` must be stacked above `@Controller`. It scans direct static routes created by `withAuthRoutes`, and authentication runs before its deferred policy check. Plain router handlers, aliases, inherited or late routes, unsupported shapes, and any route-level `authorization` option (even `false`) fail during class definition. String resource references support remote-policy decoupling; class references are validated locally.

Actions infer fail-closed: GET collection/member becomes `list`/`read`, POST collection becomes `create`, PUT/PATCH member becomes `update`, and DELETE member becomes `delete`. Ambiguous routes require `@ResourceAction`. The default ID parameter is `id`. `@Endpoint` still owns OpenAPI documentation; resource authorization neither replaces it nor adds a vendor extension.

Decisions expose a stable category (`allow-rule-matched`, `explicit-deny`, `no-matching-allow`, or `resource-unavailable`) plus sorted decisive rule IDs. These travel as log-only authorization detail to HTTP/GraphQL denial hooks. Serialized errors remain generic and do not disclose policy structure.

## Future boundaries

[OAuth2/OIDC authorization-server support (#118)](https://github.com/di-framework/di-framework/issues/118) and [GraphQL policy bindings (#119)](https://github.com/di-framework/di-framework/issues/119) are separate follow-up features. The latter will reuse this AST, evaluator, providers, and decision shape; neither belongs to the policy-neutral authentication core.
