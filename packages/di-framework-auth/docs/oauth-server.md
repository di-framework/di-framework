# OAuth 2.0 / OpenID Connect Authorization Server — Threat Model & Specifications

## Overview

`@di-framework/auth/server` provides OAuth 2.0 (RFC 6749) and OpenID Connect Core 1.0 Authorization Server capabilities. It enforces modern security defaults, including mandatory Proof Key for Code Exchange (PKCE, RFC 7636) for authorization code flows and exact URI redirect matching.

---

## 1. Supported Standards & Specifications

| Standard | Description | Enforcement |
| :--- | :--- | :--- |
| **RFC 6749** | The OAuth 2.0 Authorization Framework | Authorization code flow supported. Implicit and Resource Owner Password Credentials grants are explicitly excluded. |
| **RFC 7636** | PKCE (Proof Key for Code Exchange) | Mandatory for all authorization code requests. Supports `S256` (SHA-256) and `plain` methods. |
| **OpenID Connect Core 1.0** | ID Tokens & UserInfo Endpoint | Issues signed ID Tokens (`RS256`, `ES256`) containing `iss`, `sub`, `aud`, `exp`, `iat`, `auth_time`, `nonce`, and `at_hash`. |
| **OpenID Connect Discovery 1.0** | Provider Metadata | Exposes metadata at `/.well-known/openid-configuration`. |
| **RFC 7517 / RFC 7519** | JWK Sets & JWT | Exposes active public keys at `/.well-known/jwks.json`. Signed bearer tokens. |
| **RFC 7009** | OAuth 2.0 Token Revocation | Supports revoking refresh tokens at `/oauth/revoke`. |
| **RFC 8414** | Authorization Server Metadata | Discovery format compliant with OAuth 2.0 AS Metadata. |

---

## 2. Threat Model & Countermeasures

### 2.1 Authorization Code Interception (RFC 7636 / PKCE)
* **Threat**: An attacker intercepts an authorization code sent via redirect and attempts to exchange it for access/ID tokens.
* **Countermeasure**: PKCE is **strictly required** for all authorization code requests. The server verifies `code_verifier` against `code_challenge` during `/oauth/token`. Without a valid `code_verifier`, token exchange fails closed.

### 2.2 Redirect URI Manipulation & Open Redirectors
* **Threat**: An attacker passes a modified or wildcard `redirect_uri` to leak authorization codes to an attacker-controlled endpoint.
* **Countermeasure**: Strict **exact string matching** against pre-registered client redirect URIs (`ClientStore`). No partial matches, subdomains, path traversal, or wildcard matches are allowed. If the URI fails exact match, request fails closed immediately with `invalid_request`.

### 2.3 Replay of Authorization Codes
* **Threat**: An attacker captures a valid authorization code and attempts to exchange it multiple times.
* **Countermeasure**: Codes are strictly single-use. `AuthCodeStore.consumeCode()` atomically invalidates the code upon first retrieval. If a code is presented a second time, the server rejects token issuance with `invalid_grant`.

### 2.4 CSRF & Clickjacking on Authorization Endpoint
* **Threat**: Cross-Site Request Forgery or iframe embedding of authorization UI.
* **Countermeasure**:
  - The `state` parameter is validated and returned transparently to client.
  - HTTP responses include `X-Frame-Options: DENY` and `Content-Security-Policy: frame-ancestors 'none'`.
  - Cache controls (`Cache-Control: no-store`, `Pragma: no-cache`) prevent caching of sensitive token or authorization responses.

### 2.5 Token Leakage & Scope Escalation
* **Threat**: A client requests scopes beyond its pre-registered permissions or accesses resources without policy evaluation.
* **Countermeasure**:
  - Requested scopes are validated against `client.allowedScopes`. Attempts to request unapproved scopes fail closed (`invalid_scope`).
  - Integration with `AuthorizationManager` / `@di-framework/authz` ensures user consent and grant decisions align with application resource policies.

### 2.6 Key Compromise & Rotation
* **Threat**: Exposure of a signing key allows forged JWTs.
* **Countermeasure**: `KeyService` provides non-disruptive key rotation with overlap windows. Multiple public keys can be advertised in JWKS while retired keys are safely phased out after expiration windows.

---

## 3. Excluded Legacy Features

To maintain a zero-vulnerability baseline:
- **Implicit Grant (`response_type=token`)**: Omitted per RFC 9700 (OAuth 2.0 Security Best Current Practice).
- **Resource Owner Password Credentials (`grant_type=password`)**: Omitted per RFC 9700 due to high credential-leakage risk.
