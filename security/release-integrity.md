# Release Integrity and Provenance

## SLSA v1.2 Build Level 2 Assessment
- **Provenance Available:** Yes, generated via `npm --provenance`.
- **Provenance Authenticated:** Yes, verified by GitHub Actions OIDC identity.
- **Build Service:** GitHub Actions hosted runners.
- **Source Available:** Yes, code is open source and commit is linked.
- **Provenance Non-forgeable:** Yes, OIDC tokens are short-lived and non-forgeable.

## Publication Paths
1. Tag-triggered `release.yml` (official).
2. `workflow_dispatch` (for manual dry-runs or specific tag triggers).
*Manual local publishing is prohibited by repository branch rules and npm org settings.*

## npm Trusted Publisher
The `di-framework` npm organization is configured to accept OIDC tokens from `di-framework/di-framework` on `main` or `v*` tags. Legacy tokens are revoked.

## Release Artifacts
The release workflow prepares tarballs and ensures they match the checked source precisely, ignoring local uncommitted files.
