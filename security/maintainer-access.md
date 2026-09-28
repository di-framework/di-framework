# Maintainer Access and Repository Protection

## Inventory
- **GitHub Admins:** Organization owners
- **GitHub Collaborators:** Core maintainers
- **Bots/Apps:** GitHub Actions, Dependabot
- **npm Owners:** Core maintainers with 2FA enforced
- **Join/Leave Policy:** Access reviewed semi-annually and upon role changes.

## MFA Requirements
- GitHub MFA is enforced for all org members.
- npm 2FA is required for package publishing.
- Backup maintainers are established.
- Emergency recovery processes are documented internally by the foundation.

## Branch and Tag Protections
- **Default Branch (`main`):**
  - Require pull request reviews before merging.
  - Require status checks to pass before merging.
  - Do not allow bypassing the above settings.
  - Restrict who can push to matching branches (only maintainers).
- **Release Tags (`v*`):**
  - Restrict who can create/delete tags.

## Automation Identities
- Only GitHub Actions triggered by trusted environments can publish to npm using provenance/OIDC.
- Untrusted PRs cannot access publish secrets.

## Control Exercise Evidence
*(Sanitized Evidence - 2026-09-28)*
- Attempted to push directly to `main` as non-admin -> **Denied**
- Attempted to publish to npm without 2FA -> **Denied**
- Merged PR with approved review -> **Allowed**
