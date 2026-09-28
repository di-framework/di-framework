# OpenSSF Best Practices & Baseline Assessment

## OSPS Baseline v2026.08.28
- **Level 1:** Met.
- **Level 2:** In progress (tracked separately).
- **Evidence:** See `maintainer-access.md`, `vulnerability-response.md`, and `security-checks.md`.
- **Verification Date:** 2026-09-28.

## Best Practices Badge (Passing)
All mandatory requirements met.
- **Basics:** Project website, open source license, documentation, issue tracker are all present.
- **Change Control:** Source code is managed via Git with required reviews.
- **Reporting:** Vulnerability reporting process established (`vulnerability-response.md`).
- **Quality:** Automated test suites and linters.
- **Security:** Static analysis (CodeQL, Scorecard) active. Build provenance via OIDC and GitHub Actions.
- **Analysis:** Vulnerability triage gates block non-compliant PRs.
