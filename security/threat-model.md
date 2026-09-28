# Threat Model

## Overview
This document outlines the threat model for `di-framework`, covering data flows, trust boundaries, and concrete abuse cases for critical packages.

## Trust Boundaries
1. **HTTP/RPC/Socket Interfaces:** All incoming requests are untrusted. `@di-framework/http` and `@di-framework/rpc` enforce strict validation.
2. **Auth & Authz:** `@di-framework/auth` and `@di-framework/authz` mediate access between the unauthenticated perimeter and internal services.
3. **Tenant Isolation:** Platform tenancy is isolated at the data access level (via `@di-framework/repo`).
4. **Native/Wasm Boundaries:** Executed components run in sandboxed Wasm environments, isolating host capabilities.

## Concrete Abuse Cases
- **Authentication Bypass:** Defended by mandatory token verification in middleware.
- **Confused Deputy:** Defended by explicit context propagation and tenant ID enforcement.
- **Cross-tenant Access:** Defended by row-level/tenant-level query scoping.
- **Dependency/Release Compromise:** Defended by SLSA Level 2 build provenance, OIDC publishing, and 2FA.

## Validations
- Resolved findings from #428 are integrated into this model as non-exploitable given the new defenses.
- Out-of-scope: Physical attacks, unrelated open-source dependencies without a path through our APIs.
